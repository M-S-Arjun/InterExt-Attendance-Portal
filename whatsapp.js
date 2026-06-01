const { EventEmitter } = require('events');
const { Client, LocalAuth } = require('whatsapp-web.js');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const database = require('./database');
const parser = require('./parser');

function cleanupChromeProcesses() {
  try {
    if (process.platform === 'win32') {
      console.log("[Process Cleanup] Scanning and terminating orphan Chrome/Chromium processes to release session locks...");
      const psCommand = `powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"name = 'chrome.exe'\\" | ForEach-Object { if ($_.CommandLine -like '*wwebjs_auth*' -or $_.CommandLine -like '*puppeteer*') { Stop-Process -Id $_.ProcessId -Force } }"`;
      execSync(psCommand, { stdio: 'ignore' });
      console.log("[Process Cleanup] Completed scanning and terminating orphan Chrome processes.");
    }
  } catch (err) {
    console.warn("[Process Cleanup] Warning: Could not execute Chrome cleanup:", err.message);
  }

  // Also search and delete stale SingletonLock files recursively in .wwebjs_auth to prevent Puppeteer hydration errors
  try {
    const authPath = path.join(__dirname, '.wwebjs_auth');
    const deleteLocks = (dir) => {
      if (!fs.existsSync(dir)) return;
      const files = fs.readdirSync(dir);
      for (const file of files) {
        const fullPath = path.join(dir, file);
        if (fs.statSync(fullPath).isDirectory()) {
          deleteLocks(fullPath);
        } else if (file === 'SingletonLock') {
          try {
            fs.unlinkSync(fullPath);
            console.log(`[Process Cleanup] Deleted stale Puppeteer lockfile: ${fullPath}`);
          } catch (e) {
            console.warn(`[Process Cleanup] Warning: Could not delete lockfile: ${fullPath}:`, e.message);
          }
        }
      }
    };
    deleteLocks(authPath);
  } catch (lockErr) {
    console.warn("[Process Cleanup] Warning: Lockfile cleanup skipped:", lockErr.message);
  }
}

class WhatsAppManager extends EventEmitter {
  constructor() {
    super();
    this.client = null;
    this.status = 'disconnected'; // 'disconnected', 'connecting', 'qr', 'authenticated', 'ready'
    this.qrCodeDataUrl = null;
    this.activeChats = [];
    this.authReadyTimeout = null;
    this.groupNameCache = {};
    this.groupIdCache = {};
    this.lastMessageTime = Date.now();
    this.lastHealthCheckTime = Date.now();
    
    // 24/7 AGGRESSIVE Health Monitor (every 2 minutes)
    this.healthCheckInterval = setInterval(() => {
      const now = Date.now();
      const timeSinceLastCheck = now - this.lastHealthCheckTime;
      this.lastHealthCheckTime = now;
      
      console.log(`[Health Monitor] Checking WhatsApp connection state: "${this.status}" | Last check: ${timeSinceLastCheck}ms ago`);
      
      if (this.status === 'disconnected') {
        console.warn("[Health Monitor] Client disconnected. Triggering immediate reboot...");
        this.initialize();
      } else if (this.status === 'ready') {
        // Check for stale/idle session - if no activity for 25 minutes, force reconnect
        const timeSinceLastMsg = now - this.lastMessageTime;
        if (timeSinceLastMsg > 1500000) { // 25 minutes
          console.warn("[Health Monitor] Session idle for 25+ minutes. Forcing reconnection to maintain 24/7 uptime...");
          this.forceReconnect();
        }
      }
    }, 120000); // 2 minutes instead of 10
    
    // KEEPALIVE: Ping connection every 3 minutes to prevent idle timeout
    this.keepAliveInterval = setInterval(() => {
      if (this.status === 'ready' && this.client) {
        console.log("[KeepAlive] Pinging WhatsApp connection to maintain session...");
        this.pingConnection();
      }
    }, 180000); // 3 minutes
  }

  // Initialize the WhatsApp Web Client with self-healing lock release
  async initialize() {
    console.log("Initializing WhatsApp Client...");
    this.status = 'connecting';
    this.emit('status', this.status);

    if (this.client) {
      try {
        console.log("Destroying previous WhatsApp client instance with safety timeout...");
        await Promise.race([
          this.client.destroy(),
          new Promise((_, reject) => setTimeout(() => reject(new Error("Client destroy timed out")), 5000))
        ]);
      } catch (e) {
        console.warn("Safety notice: previous client destroy skipped or timed out:", e.message);
      }
      this.client = null;
    }

    // Always scan and terminate orphan Chrome processes to release wwebjs_auth session locks
    cleanupChromeProcesses();

    try {
      this.client = new Client({
        authStrategy: new LocalAuth({
          dataPath: './.wwebjs_auth' // stores authentication session in workspace
        }),
        authTimeoutMs: 120000, // 2 minutes timeout for auth
        qrTimeoutMs: 120000,   // 2 minutes timeout for QR scanning
        webVersionCache: {
          type: 'remote',
          remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html'
        },
        puppeteer: {
          headless: true,
          protocolTimeout: 240000, // Terminate Protocol errors by setting 240s timeout (4 minutes for large accounts)
          args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--disable-gpu',
            '--disable-extensions',
            '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
          ]
        }
      });

      this.registerEvents();
      this.client.initialize();
    } catch (err) {
      console.error("Failed to initialize WhatsApp Client:", err);
      this.status = 'disconnected';
      this.emit('status', this.status);
    }
  }

  // Register WhatsApp Event Listeners
  registerEvents() {
    // QR Code generated - convert to Base64 image
    this.client.on('qr', async (qr) => {
      console.log("QR Code received. Generating image...");
      try {
        this.qrCodeDataUrl = await QRCode.toDataURL(qr);
        this.status = 'qr';
        this.emit('qr', this.qrCodeDataUrl);
        this.emit('status', this.status);
      } catch (err) {
        console.error("QR Code Image generation failed:", err);
      }
    });

    // Successfully Authenticated
    this.client.on('authenticated', () => {
      console.log("WhatsApp authenticated successfully!");
      this.status = 'authenticated';
      this.qrCodeDataUrl = null;
      this.emit('status', this.status);

      // Start 3-minute watchdog timer for ready state to prevent hydration hangs (large accounts require more boot time)
      if (this.authReadyTimeout) clearTimeout(this.authReadyTimeout);
      this.authReadyTimeout = setTimeout(async () => {
        console.warn("[Watchdog] WhatsApp authenticated but ready event timed out (3 minutes). Self-healing re-initialization triggered...");
        this.status = 'disconnected';
        this.emit('status', this.status);
        
        try {
          console.log("[Watchdog] Destroying hung client instance...");
          await Promise.race([
            this.client.destroy(),
            new Promise((_, reject) => setTimeout(() => reject(new Error("Watchdog client destroy timed out")), 5000))
          ]);
        } catch (e) {
          console.error("[Watchdog] Client destruction failed:", e.message);
        }
        
        try {
          console.log("[Watchdog] Wiping corrupted session and cache directories...");
          const authPath = path.join(__dirname, '.wwebjs_auth');
          const cachePath = path.join(__dirname, '.wwebjs_cache');
          if (fs.existsSync(authPath)) {
            fs.rmSync(authPath, { recursive: true, force: true });
          }
          if (fs.existsSync(cachePath)) {
            fs.rmSync(cachePath, { recursive: true, force: true });
          }
        } catch (e) {
          console.error("[Watchdog] Failed to clean directories:", e.message);
        }

        console.log("[Watchdog] Re-initializing fresh client...");
        this.initialize();
      }, 180000);
    });

    // Session authentication failed
    this.client.on('auth_failure', (msg) => {
      console.error("WhatsApp authentication failure:", msg);
      
      // Clear watchdog timer
      if (this.authReadyTimeout) {
        clearTimeout(this.authReadyTimeout);
        this.authReadyTimeout = null;
      }

      this.status = 'disconnected';
      this.qrCodeDataUrl = null;
      this.emit('status', this.status);

      // Clean up session auth data and auto-reinitialize
      try {
        console.log("Cleaning up corrupted auth session...");
        const authPath = path.join(__dirname, '.wwebjs_auth');
        if (fs.existsSync(authPath)) {
          fs.rmSync(authPath, { recursive: true, force: true });
        }
      } catch (e) {
        console.error("Failed to clean auth path:", e.message);
      }
      setTimeout(() => this.initialize(), 5000);
    });

    // Client is logged in and ready to receive messages
    this.client.on('ready', async () => {
      console.log("WhatsApp Client is ready!");

      // Clear watchdog timer
      if (this.authReadyTimeout) {
        clearTimeout(this.authReadyTimeout);
        this.authReadyTimeout = null;
      }

      this.status = 'ready';
      this.qrCodeDataUrl = null;
      this.emit('status', this.status);

      // Auto-resolve stable WhatsApp Group ID by configured Group Name
      try {
        const settings = database.getSettings();
        if (settings.whatsappGroupName) {
          console.log(`[Startup] Resolving stable Group ID for "${settings.whatsappGroupName}"...`);
          const chats = await this.client.getChats();
          const matchedGroup = chats.find(c => c.isGroup && c.name.trim().toLowerCase() === settings.whatsappGroupName.trim().toLowerCase());
          if (matchedGroup) {
            const gid = matchedGroup.id._serialized;
            if (settings.whatsappGroupId !== gid) {
              console.log(`[Startup] Group resolved. Saving stable ID to settings: ${gid}`);
              database.saveSettings({ ...settings, whatsappGroupId: gid });
            }
            // Trigger recovery of missed messages on startup
            await this.recoverMissedMessages(matchedGroup);
          } else {
            console.warn(`[Startup] Active WhatsApp group named "${settings.whatsappGroupName}" not found in chat directory.`);
          }
        }
      } catch (err) {
        console.error("[Startup] Failed to auto-resolve WhatsApp Group ID:", err);
      }
    });

    // Session disconnected
    this.client.on('disconnected', (reason) => {
      console.log("WhatsApp client disconnected:", reason);

      // Clear watchdog timer
      if (this.authReadyTimeout) {
        clearTimeout(this.authReadyTimeout);
        this.authReadyTimeout = null;
      }

      this.status = 'disconnected';
      this.qrCodeDataUrl = null;
      this.emit('status', this.status);
      
      // Auto-reconnect after delay
      setTimeout(() => this.initialize(), 5000);
    });

    // Handle Incoming and Outgoing Messages
    this.client.on('message_create', async (message) => {
      try {
        await this.processMessage(message);
      } catch (err) {
        console.error("Error in message_create event handler:", err);
      }
    });
  }

  // Process individual WhatsApp message (both live and recovered history)
  async processMessage(message) {
    this.lastMessageTime = Date.now(); // Update activity timestamp
    try {
      const settings = database.getSettings();
      if (!settings.whatsappGroupName) return; // No group selected yet

      const chatId = message.from;
      let groupName = this.groupNameCache[chatId];
      let groupId = this.groupIdCache[chatId];

      if (!groupName) {
        console.log(`[Message Processor] Resolving chat for ID: ${chatId}...`);
        const chat = await message.getChat();
        if (chat.isGroup) {
          groupName = chat.name.trim();
          groupId = chat.id && chat.id._serialized ? chat.id._serialized : chat.id;
          this.groupNameCache[chatId] = groupName;
          this.groupIdCache[chatId] = groupId;
          console.log(`[Message Processor] Cached group name: "${groupName}" -> ID: ${chatId}`);
        }
      }

      // Filter messages belonging only to our selected Attendance Group
      const configuredGroupId = settings.whatsappGroupId || null;
      const configuredGroupName = settings.whatsappGroupName || null;

      // Match by groupId if configured, otherwise fall back to case-insensitive name match
      const isMatchingGroup = (configuredGroupId && groupId && configuredGroupId === groupId)
        || (groupName && configuredGroupName && groupName.toLowerCase() === configuredGroupName.trim().toLowerCase());

      if (isMatchingGroup) {
        const msgId = message.id._serialized;
        
        // De-duplicate check
        const processedIds = database.getProcessedMessageIds();
        if (processedIds.includes(msgId)) {
          return; // Skip already processed messages
        }

        const msgTimestampISO = new Date(message.timestamp * 1000).toISOString();

        // Emit a lightweight raw message event for real-time UI feed only for the configured group
        try {
          const senderPhone = (message.author || message.from).split('@')[0];
          this.emit('raw_message', {
            chatId,
            groupId,
            groupName,
            sender: senderPhone,
            messageText: message.body,
            timestamp: msgTimestampISO
          });
        } catch (e) {
          // Non-fatal - continue
        }

        console.log(`Processing group message from ${message.author || message.from}: "${message.body || ''}"`);
        
        // Get clean phone number of sender
        const senderPhone = (message.author || message.from).split('@')[0];
        
        const isPhoto = message.hasMedia && (message.type === 'image' || message.type === 'document');
        const isLocation = message.type === 'location';
        
        if (isPhoto) {
          console.log(`[Selfie Verifier] Media check-in received from +${senderPhone}`);
          try {
            const media = await message.downloadMedia();
            if (media && media.mimetype && media.mimetype.startsWith('image/')) {
              const selfieRecord = await database.verifyAndSaveSelfie(
                message.id._serialized,
                senderPhone,
                message.body || '', // Caption is contained in message.body
                media.data, // Base64 content
                media.mimetype,
                msgTimestampISO
              );
              
              console.log(`[Selfie Verifier] Media parsed. Status: ${selfieRecord.status}`);
              this.emit('selfie_received', selfieRecord);
            }
          } catch (err) {
            console.error("[Selfie Verifier] Failed to process media attachment:", err.message);
          }
        } else if (isLocation) {
          console.log(`[Location Parser] Location pin received from +${senderPhone}: Lat: ${message.location.latitude}, Lon: ${message.location.longitude}`);
          try {
            const updatedSelfie = await database.applyLocationPinToRecentSelfie(
              senderPhone,
              message.location.latitude,
              message.location.longitude,
              msgTimestampISO
            );
            if (updatedSelfie) {
              console.log(`[Location Parser] Successfully attached GPS coordinates to recent selfie. Status: ${updatedSelfie.status}`);
              this.emit('selfie_updated', updatedSelfie);
            }
          } catch (err) {
            console.error("[Location Parser] Failed to process location message:", err.message);
          }
        } else {
          // Standard Text Message Parsing
          const parseResult = parser.parse(message.body, senderPhone, msgTimestampISO);
          
          // Store/update log in database
          const loggedRecord = database.recordFromWhatsApp(parseResult, message.body, msgTimestampISO);
          
          // Emit WebSocket notification to refresh UI
          this.emit('message_received', {
            sender: senderPhone,
            groupId,
            groupName,
            messageText: message.body,
            timestamp: msgTimestampISO,
            parseResult,
            loggedRecord
          });
        }

        // Save ID as processed
        database.saveProcessedMessageId(msgId);
      }
    } catch (err) {
      console.error("Error processing incoming WhatsApp message:", err);
    }
  }

  // Historical Recovery Engine: Fetches and parses missed messages on system boot
  async recoverMissedMessages(chat) {
    console.log(`[Recovery Engine] Starting missed messages recovery for group: "${chat.name}"...`);
    try {
      // Fetch the last 150 messages from the group
      const messages = await chat.fetchMessages({ limit: 150 });
      console.log(`[Recovery Engine] Fetched ${messages.length} historical messages from WhatsApp.`);

      const processedIds = database.getProcessedMessageIds();
      const isInitialSync = processedIds.length === 0;

      if (isInitialSync) {
        console.log("[Recovery Engine] Initial startup sync: Seeding existing message IDs to establish baseline...");
        const idsToSeed = messages.map(msg => msg.id._serialized);
        
        // Save the baseline IDs to database so they are never processed in the future
        database.saveProcessedMessageIds(idsToSeed);
        console.log(`[Recovery Engine] Initial baseline seeded with ${idsToSeed.length} message IDs. Future boots will parse missed messages.`);
        return;
      }

      // If not initial sync, process any message that has not been processed yet
      let processedCount = 0;
      
      // Chronological sort (oldest to newest) to process check-ins and check-outs sequentially
      const sortedMessages = [...messages].sort((a, b) => a.timestamp - b.timestamp);

      for (const msg of sortedMessages) {
        const msgId = msg.id._serialized;
        if (!processedIds.includes(msgId)) {
          console.log(`[Recovery Engine] Found missed message from ${msg.author || msg.from} sent at ${new Date(msg.timestamp * 1000).toISOString()}: "${msg.body || ''}"`);
          // Process this message using the processor logic
          await this.processMessage(msg);
          processedCount++;
        }
      }

      console.log(`[Recovery Engine] Missed messages recovery complete. Processed ${processedCount} missed messages.`);
    } catch (err) {
      console.error("[Recovery Engine] Failed to recover missed messages:", err);
    }
  }
  }

  // Refresh and fetch all available group chat names
  async refreshChats() {
    if (this.status !== 'ready') return [];
    try {
      const chats = await this.client.getChats();
      // Filter out only groups to keep the dashboard clean
      this.activeChats = chats
        .filter(c => c.isGroup)
        .map(c => ({
          id: c.id._serialized,
          name: c.name,
          unreadCount: c.unreadCount
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
      
      this.emit('chats_updated', this.activeChats);
      return this.activeChats;
    } catch (err) {
      console.error("Failed to load WhatsApp chats:", err);
      return [];
    }
  }

  // Ping connection to maintain session and detect stale connections
  async pingConnection() {
    try {
      if (this.client && this.status === 'ready') {
        // Try to refresh chats to keep connection alive
        const chats = await this.client.getChats();
        console.log(`[KeepAlive] Successfully pinged connection. Active chats: ${chats.length}`);
        return true;
      }
    } catch (err) {
      console.error("[KeepAlive] Ping failed:", err.message);
      console.warn("[KeepAlive] Connection appears stale. Triggering reconnection...");
      this.forceReconnect();
      return false;
    }
  }

  // Force reconnect without waiting for disconnect event
  async forceReconnect() {
    console.log("[ForceReconnect] Initiating forced reconnection...");
    
    try {
      if (this.client) {
        await Promise.race([
          this.client.destroy(),
          new Promise((_, reject) => setTimeout(() => reject(new Error("Force destroy timeout")), 3000))
        ]);
      }
    } catch (e) {
      console.warn("[ForceReconnect] Client destroy failed:", e.message);
    }
    
    this.client = null;
    this.status = 'disconnected';
    this.emit('status', this.status);
    
    // Reinitialize after short delay
    setTimeout(() => {
      console.log("[ForceReconnect] Restarting WhatsApp client...");
      this.initialize();
    }, 2000);
  }

  // Manually disconnect session
  async logout() {
    if (!this.client) return;
    try {
      await this.client.logout();
      this.status = 'disconnected';
      this.qrCodeDataUrl = null;
      this.emit('status', this.status);
    } catch (err) {
      console.error("Failed during WhatsApp logout:", err);
    }
  }

  // Cleanup intervals on shutdown
  destroy() {
    if (this.healthCheckInterval) clearInterval(this.healthCheckInterval);
    if (this.keepAliveInterval) clearInterval(this.keepAliveInterval);
  }
}

module.exports = new WhatsAppManager();
