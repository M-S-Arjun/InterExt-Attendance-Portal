const { EventEmitter } = require('events');
const { Client, LocalAuth } = require('whatsapp-web.js');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const https = require('https');
const database = require('./database');
const parser = require('./parser');

function getLatestWWebVersion() {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.github.com',
      path: '/repos/wppconnect-team/wa-version/contents/html',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko)'
      },
      timeout: 8000
    };

    const req = https.get(options, (res) => {
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => {
        try {
          if (res.statusCode !== 200) {
            return reject(new Error(`HTTP status ${res.statusCode}`));
          }
          const files = JSON.parse(body);
          if (!Array.isArray(files) || files.length === 0) {
            return reject(new Error('Invalid response structure from GitHub API'));
          }
          const htmlFiles = files
            .map(f => f.name)
            .filter(name => name.endsWith('.html'))
            .map(name => name.replace('.html', ''));
          
          if (htmlFiles.length === 0) {
            return reject(new Error('No HTML files found in repository'));
          }

          // Sort alphabetically/semver-wise to find the latest
          htmlFiles.sort((a, b) => {
            return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
          });

          const latest = htmlFiles[htmlFiles.length - 1];
          resolve(latest);
        } catch (err) {
          reject(err);
        }
      });
    });

    req.on('error', (err) => reject(err));
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timed out'));
    });
  });
}


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
    this.isInitializing = false;
    this.qrCodeDataUrl = null;
    this.activeChats = [];
    this.authReadyTimeout = null;
    this.groupNameCache = {};
    this.groupIdCache = {};
    this.lidToPhoneMap = {};
    this.lastMessageTime = Date.now();
    this.lastHealthCheckTime = Date.now();
    this.connectingTimeout = null;
    this.connectingTimeoutAt = 0;
    
    // 24/7 Health Monitor (every 2 minutes)
    this.healthCheckInterval = setInterval(() => {
      const now = Date.now();
      const timeSinceLastCheck = now - this.lastHealthCheckTime;
      this.lastHealthCheckTime = now;
      
      console.log(`[Health Monitor] Checking WhatsApp connection state: "${this.status}" | Last check: ${timeSinceLastCheck}ms ago`);
      
      if (this.status === 'disconnected') {
        console.warn("[Health Monitor] Client disconnected. Triggering immediate reboot...");
        this.initialize();
      }
    }, 120000); // 2 minutes
    
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
    if (this.isInitializing) {
      if (this.connectingTimeoutAt && Date.now() - this.connectingTimeoutAt > 180000) {
        console.warn("[Startup] Client stuck in initializing state for >3 minutes. Clearing block and restarting...");
        this.isInitializing = false;
      } else {
        console.log("[Startup] Already initializing. Skipping duplicate request.");
        return;
      }
    }
    this.isInitializing = true;
    this.connectingTimeoutAt = Date.now();
    console.log("Initializing WhatsApp Client...");
    this.status = 'connecting';
    this.emit('status', this.status);

    // Start a 3-minute watchdog timer to prevent getting stuck in 'connecting' state
    if (this.connectingTimeout) clearTimeout(this.connectingTimeout);
    this.connectingTimeout = setTimeout(async () => {
      if (this.status === 'connecting') {
        console.warn("[Watchdog] WhatsApp client initialization stuck in 'connecting' state for 3 minutes. Re-initializing...");
        this.status = 'disconnected';
        this.isInitializing = false;
        this.emit('status', this.status);
        this.forceReconnect();
      }
    }, 180000); // 3 minutes

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

    let webVersion = '2.3000.1040735178-alpha';
    try {
      console.log("[WhatsApp Cache] Resolving latest WhatsApp Web version from wppconnect-team/wa-version...");
      const resolved = await getLatestWWebVersion();
      webVersion = resolved;
      console.log(`[WhatsApp Cache] Successfully resolved latest remote version: ${webVersion}`);
    } catch (err) {
      console.warn(`[WhatsApp Cache] Could not dynamically resolve latest version: ${err.message}. Using fallback: ${webVersion}`);
    }

    try {
      this.client = new Client({
        authStrategy: new LocalAuth({
          dataPath: './.wwebjs_auth' // stores authentication session in workspace
        }),
        takeoverOnConflict: true,
        takeoverTimeoutMs: 0,
        authTimeoutMs: 120000, // 2 minutes timeout for auth
        qrTimeoutMs: 120000,   // 2 minutes timeout for QR scanning
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
        webVersion: webVersion,
        webVersionCache: {
          type: 'remote',
          remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/{version}.html',
          strict: false
        },
        puppeteer: {
          headless: true,
          protocolTimeout: 240000, // Terminate Protocol errors by setting 240s timeout (4 minutes for large accounts)
          args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--no-first-run',
            '--no-zygote',
            '--disable-extensions',
            '--disable-gpu'
          ]
        }
      });

      this.registerEvents();
      this.client.initialize().catch(err => {
        console.error("[Startup] Client initialization promise rejected:", err);
        this.status = 'disconnected';
        this.isInitializing = false;
        this.emit('status', this.status);
        setTimeout(() => this.initialize(), 5000);
      });
    } catch (err) {
      console.error("Failed to initialize WhatsApp Client:", err);
      this.status = 'disconnected';
      this.isInitializing = false;
      this.emit('status', this.status);
      setTimeout(() => this.initialize(), 5000);
    }
  }

  // Register WhatsApp Event Listeners
  registerEvents() {
    // QR Code generated - convert to Base64 image
    this.client.on('qr', async (qr) => {
      console.log("QR Code received. Generating image...");
      this.clearConnectingTimeout();
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
      this.clearConnectingTimeout();
      this.status = 'authenticated';
      this.qrCodeDataUrl = null;
      this.emit('status', this.status);

      // Start 5-minute watchdog timer for ready state to prevent hydration hangs (large accounts require more boot time)
      if (this.authReadyTimeout) clearTimeout(this.authReadyTimeout);
      this.authReadyTimeout = setTimeout(async () => {
        console.warn("[Watchdog] WhatsApp authenticated but ready event timed out (5 minutes). Self-healing re-initialization triggered...");
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

        console.log("[Watchdog] Re-initializing client...");
        this.isInitializing = false;
        this.initialize();
      }, 300000);
    });

    // Session authentication failed
    this.client.on('auth_failure', (msg) => {
      console.error("WhatsApp authentication failure:", msg);
      this.clearConnectingTimeout();
      
      // Clear watchdog timer
      if (this.authReadyTimeout) {
        clearTimeout(this.authReadyTimeout);
        this.authReadyTimeout = null;
      }

      this.status = 'disconnected';
      this.isInitializing = false;
      this.qrCodeDataUrl = null;
      this.emit('status', this.status);

      // Do NOT clean up session auth data immediately to prevent destroying active logins on transient/loading failures.
      // If the session is truly invalid, whatsapp-web.js will naturally display the QR code page next time.
      setTimeout(() => this.initialize(), 5000);
    });

    // Client is logged in and ready to receive messages
    this.client.on('ready', async () => {
      console.log("WhatsApp Client is ready!");
      this.clearConnectingTimeout();

      // Clear watchdog timer
      if (this.authReadyTimeout) {
        clearTimeout(this.authReadyTimeout);
        this.authReadyTimeout = null;
      }

      this.status = 'ready';
      this.isInitializing = false;
      this.qrCodeDataUrl = null;
      this.emit('status', this.status);

      // Run startup routines asynchronously in the background so they don't block boot
      this.runStartupRoutines().catch(err => {
        console.error("[Startup] Error running background routines:", err);
      });
    });

    // Session disconnected
    this.client.on('disconnected', (reason) => {
      console.log("WhatsApp client disconnected:", reason);
      this.clearConnectingTimeout();

      // Clear watchdog timer
      if (this.authReadyTimeout) {
        clearTimeout(this.authReadyTimeout);
        this.authReadyTimeout = null;
      }

      this.status = 'disconnected';
      this.isInitializing = false;
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
      // Resolve the chat ID (accounting for outgoing messages from the client itself)
      const chatId = message.fromMe ? message.to : message.from;
      
      // Strictly ignore direct messages (individual chats) to protect privacy.
      // Group chat JIDs in WhatsApp always end with @g.us.
      if (!chatId || !chatId.endsWith('@g.us')) {
        return;
      }

      const settings = database.getSettings();
      const targetGroupNames = (settings.whatsappGroupName || 'ATTENDANCE')
        .split(',')
        .map(name => name.trim().toLowerCase())
        .filter(Boolean);

      const targetGroupIds = (settings.whatsappGroupId || '')
        .split(',')
        .map(id => id.trim())
        .filter(Boolean);

      let groupName = this.groupNameCache[chatId];
      let groupId = this.groupIdCache[chatId];

      if (!groupName) {
        if (targetGroupIds.includes(chatId)) {
          console.log(`[Message Processor] Resolving group chat for ID: ${chatId}...`);
          try {
            const chat = await Promise.race([
              message.getChat(),
              new Promise((_, reject) => setTimeout(() => reject(new Error("getChat timeout")), 8000))
            ]);
            if (chat && chat.isGroup) {
              groupName = chat.name.trim();
              groupId = chat.id && chat.id._serialized ? chat.id._serialized : chat.id;
              this.groupNameCache[chatId] = groupName;
              this.groupIdCache[chatId] = groupId;
            }
          } catch (e) {
            console.error(`[Message Processor] Failed to resolve group chat for ID ${chatId}:`, e.message);
          }
        } else {
          console.log(`[Message Processor] Resolving group chat for ID: ${chatId}...`);
          try {
            const chat = await Promise.race([
              message.getChat(),
              new Promise((_, reject) => setTimeout(() => reject(new Error("getChat timeout")), 8000))
            ]);
            if (chat && chat.isGroup) {
              groupName = chat.name.trim();
              groupId = chat.id && chat.id._serialized ? chat.id._serialized : chat.id;
              this.groupNameCache[chatId] = groupName;
              this.groupIdCache[chatId] = groupId;
              console.log(`[Message Processor] Cached group name: "${groupName}" -> ID: ${chatId}`);
            }
          } catch (e) {
            console.error(`[Message Processor] Failed to resolve group chat for ID ${chatId}:`, e.message);
          }
        }
      }

      // Enforce matching strictly the target groups (case-insensitive)
      if (!groupName || !targetGroupNames.includes(groupName.toLowerCase())) {
        return;
      }

      // Auto-heal group JIDs in settings if missing
      if (groupId && !targetGroupIds.includes(groupId)) {
        console.log(`[Auto-Heal] Group ID missing in settings. Adding JID "${groupId}" to settings.`);
        const updatedIds = [...targetGroupIds, groupId].join(', ');
        database.saveSettings({ ...settings, whatsappGroupId: updatedIds });
      }

      const isMatchingGroup = true;
      if (isMatchingGroup) {
        // Filter out system messages or messages with empty body that aren't media/locations
        const isPhoto = message.hasMedia && (message.type === 'image' || message.type === 'document');
        const isLocation = message.type === 'location';
        const hasEmptyBody = !message.body || message.body.trim().length === 0;
        const isSystem = message.isSystem || !message.author;

        if (isSystem || (hasEmptyBody && !isPhoto && !isLocation)) {
          return; // Skip system messages and empty messages
        }

        const msgId = message.id._serialized;
        
        // De-duplicate check
        const processedIds = database.getProcessedMessageIds();
        if (processedIds.includes(msgId)) {
          return; // Skip already processed messages
        }

        const msgTimestampISO = new Date(message.timestamp * 1000).toISOString();

        // Get clean phone number of sender, resolving LID if necessary
        const rawSenderJid = message.author || message.from;
        let senderPhone = rawSenderJid.split('@')[0].replace(/\D/g, '');
        
        if (this.lidToPhoneMap[senderPhone]) {
          senderPhone = this.lidToPhoneMap[senderPhone].split('@')[0].replace(/\D/g, '');
        } else if (rawSenderJid.endsWith('@lid')) {
          try {
            if (this.client && typeof this.client.getContactLidAndPhone === 'function') {
              const mappings = await this.client.getContactLidAndPhone([rawSenderJid]);
              if (mappings && mappings.length > 0 && mappings[0].pn) {
                const cleanPn = mappings[0].pn.split('@')[0].replace(/\D/g, '');
                console.log(`[LID Resolver] Resolved ${rawSenderJid} -> ${cleanPn} via getContactLidAndPhone`);
                senderPhone = cleanPn;
                this.lidToPhoneMap[rawSenderJid.split('@')[0]] = senderPhone;
              }
            }
          } catch (lidErr) {
            console.warn("[LID Resolver] getContactLidAndPhone failed:", lidErr.message);
          }

          if (senderPhone === rawSenderJid.split('@')[0].replace(/\D/g, '')) {
            try {
              const contact = await message.getContact();
              if (contact && contact.number) {
                const cleanPn = contact.number.split('@')[0].replace(/\D/g, '');
                console.log(`[LID Resolver] Resolved ${rawSenderJid} -> ${cleanPn} via contact.number`);
                senderPhone = cleanPn;
                this.lidToPhoneMap[rawSenderJid.split('@')[0]] = senderPhone;
              }
            } catch (contactErr) {
              console.warn("[LID Resolver] getContact failed:", contactErr.message);
            }
          }
        }

        // Emit a lightweight raw message event for real-time UI feed only for the configured group
        try {
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

        console.log(`Processing group message from ${rawSenderJid} (resolved PN: ${senderPhone}): "${message.body || ''}"`);
        
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
      // Fetch the last 500 messages from the group
      const messages = await chat.fetchMessages({ limit: 500 });
      console.log(`[Recovery Engine] Fetched ${messages.length} historical messages from WhatsApp.`);

      const processedIds = database.getProcessedMessageIds();

      // Process any message that has not been processed yet
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

  // Live resolve stable Group IDs by configured Group Names
  async resolveGroupIds() {
    if (this.status !== 'ready') return [];
    try {
      const settings = database.getSettings();
      const targetGroupNames = (settings.whatsappGroupName || 'ATTENDANCE')
        .split(',')
        .map(name => name.trim().toLowerCase())
        .filter(Boolean);
      
      console.log(`[Startup] Resolving stable Group IDs for: ${targetGroupNames.join(', ')}`);
      const chats = await this.client.getChats();
      const matchedGroups = [];
      const updatedIdsList = [];

      for (const targetName of targetGroupNames) {
        const matchedGroup = chats.find(c => c.isGroup && c.name && c.name.trim().toLowerCase() === targetName);
        if (matchedGroup) {
          matchedGroups.push(matchedGroup);
          updatedIdsList.push(matchedGroup.id._serialized);
        } else {
          console.warn(`[Startup] Active WhatsApp group named "${targetName}" not found in chat directory.`);
        }
      }

      const uniqueIds = [...new Set(updatedIdsList)];
      if (uniqueIds.join(', ') !== settings.whatsappGroupId) {
        database.saveSettings({ ...settings, whatsappGroupId: uniqueIds.join(', ') });
      }
      return matchedGroups;
    } catch (err) {
      console.error("[Startup] Failed to resolve stable Group IDs:", err);
      return [];
    }
  }

  // Legacy wrapper for backwards compatibility
  async resolveGroupId() {
    const groups = await this.resolveGroupIds();
    return groups.length > 0 ? groups[0] : null;
  }

  // Refresh and fetch all available group chat names
  async refreshChats() {
    if (this.status !== 'ready') return [];
    try {
      const chats = await this.client.getChats();
      // Filter strictly to target group names to protect personal chat privacy
      const settings = database.getSettings();
      const targetGroupNames = (settings.whatsappGroupName || 'ATTENDANCE')
        .split(',')
        .map(name => name.trim().toLowerCase())
        .filter(Boolean);

      this.activeChats = chats
        .filter(c => c.isGroup && c.name && targetGroupNames.includes(c.name.trim().toLowerCase()))
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
        // Lighter ping check using evaluating a simple script inside the browser page
        if (this.client.pupBrowser && this.client.pupPage) {
          const isClosed = this.client.pupBrowser.isConnected ? !this.client.pupBrowser.isConnected() : false;
          if (isClosed) {
            throw new Error("Puppeteer browser is disconnected");
          }
          await this.client.pupPage.evaluate(() => 1);
          console.log("[KeepAlive] Successfully pinged connection (browser is responding).");
          return true;
        } else {
          throw new Error("Puppeteer client not fully initialized");
        }
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
    this.isInitializing = false;
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
    } catch (err) {
      console.error("Failed during WhatsApp logout:", err);
    } finally {
      this.status = 'disconnected';
      this.isInitializing = false;
      this.qrCodeDataUrl = null;
      this.emit('status', this.status);
    }
  }

  clearConnectingTimeout() {
    if (this.connectingTimeout) {
      clearTimeout(this.connectingTimeout);
      this.connectingTimeout = null;
    }
  }

  // Background startup routines that run asynchronously to avoid blocking the main ready handler
  async runStartupRoutines() {
    console.log("[Startup] Starting WhatsApp background routines...");
    const settings = database.getSettings();
    const targetGroupNames = (settings.whatsappGroupName || 'ATTENDANCE')
      .split(',')
      .map(name => name.trim())
      .filter(Boolean);
    const targetGroupNamesLower = targetGroupNames.map(name => name.toLowerCase());

    const targetGroupIds = (settings.whatsappGroupId || '')
      .split(',')
      .map(id => id.trim())
      .filter(Boolean);

    const resolvedGroups = [];
    const updatedIdsList = [];

    // 1. First, try to load chat directly from cached Group IDs and verify names
    for (const gid of targetGroupIds) {
      try {
        console.log(`[Startup] Attempting to load chat directly by cached ID: ${gid}`);
        const chat = await this.client.getChatById(gid);
        if (chat && chat.isGroup && chat.name) {
          const nameLower = chat.name.trim().toLowerCase();
          if (targetGroupNamesLower.includes(nameLower)) {
            resolvedGroups.push(chat);
            updatedIdsList.push(gid);
            console.log(`[Startup] Successfully loaded and verified chat by cached ID: ${gid} ("${chat.name}")`);
          } else {
            console.warn(`[Startup] Cached group JID ${gid} name is "${chat.name}", which does not match any target. Skipping...`);
          }
        }
      } catch (e) {
        console.warn(`[Startup] Cached Group ID ${gid} lookup failed:`, e.message);
      }
    }

    // 2. For any target group names not yet resolved, search chats list
    const resolvedNamesLower = resolvedGroups.map(c => c.name.trim().toLowerCase());
    const missingNamesLower = targetGroupNamesLower.filter(name => !resolvedNamesLower.includes(name));

    if (missingNamesLower.length > 0) {
      try {
        console.log("[Startup] Scanning chats directory to find missing groups...");
        const chats = await Promise.race([
          this.client.getChats(),
          new Promise((_, reject) => setTimeout(() => reject(new Error("getChats timeout")), 25000))
        ]);
        
        for (const nameLower of missingNamesLower) {
          const chat = chats.find(c => c.isGroup && c.name && c.name.trim().toLowerCase() === nameLower);
          if (chat) {
            const gid = chat.id._serialized;
            resolvedGroups.push(chat);
            updatedIdsList.push(gid);
            console.log(`[Startup] Found matching group "${chat.name}" by name. Caching ID: ${gid}`);
          } else {
            console.warn(`[Startup] Group named "${nameLower}" could not be resolved from chats directory.`);
          }
        }
      } catch (err) {
        console.error("[Startup] Failed to scan chats directory:", err.message);
      }
    }

    // Save all resolved group JIDs back to settings
    const uniqueIds = [...new Set(updatedIdsList)];
    if (uniqueIds.join(', ') !== settings.whatsappGroupId) {
      database.saveSettings({ ...settings, whatsappGroupId: uniqueIds.join(', ') });
    }

    // 3. Process each resolved group
    for (const group of resolvedGroups) {
      const gid = group.id._serialized;
      this.groupNameCache[gid] = group.name;
      this.groupIdCache[gid] = gid;

      try {
        await this.buildLidMappingForChat(group);
      } catch (err) {
        console.error(`[Startup] LID mapping failed for group "${group.name}":`, err.message);
      }

      try {
        await this.recoverMissedMessages(group);
      } catch (err) {
        console.error(`[Startup] Missed messages recovery failed for group "${group.name}":`, err.message);
      }
    }
  }

  // Build LID to Phone mapping directly from a pre-loaded group chat object
  async buildLidMappingForChat(attendanceChat) {
    if (!this.client || !attendanceChat) return;
    try {
      const participants = attendanceChat.groupMetadata.participants || [];
      const lids = participants.map(p => p.id._serialized).filter(id => id.endsWith('@lid'));
      
      if (lids.length > 0) {
        console.log(`[LID Resolver] Resolving ${lids.length} LIDs from group participants...`);
        
        // Try getContactLidAndPhone first
        if (typeof this.client.getContactLidAndPhone === 'function') {
          try {
            const mappings = await this.client.getContactLidAndPhone(lids);
            if (mappings && mappings.length > 0) {
              mappings.forEach(m => {
                if (m.lid && m.pn) {
                  const cleanLid = m.lid.split('@')[0];
                  const cleanPn = m.pn.split('@')[0].replace(/\D/g, '');
                  this.lidToPhoneMap[cleanLid] = cleanPn;
                  console.log(`[LID Resolver] Mapped ${cleanLid} -> ${cleanPn}`);
                }
              });
            }
          } catch (err) {
            console.warn("[LID Resolver] getContactLidAndPhone failed during bulk map:", err.message);
          }
        }

        // Fallback for any unmapped LIDs in parallel with safety timeout
        const fallbackPromises = lids.map(async (lidJid) => {
          const cleanLid = lidJid.split('@')[0];
          if (!this.lidToPhoneMap[cleanLid]) {
            try {
              const contact = await Promise.race([
                this.client.getContactById(lidJid),
                new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout")), 5000))
              ]);
              if (contact && contact.number) {
                const cleanPn = contact.number.split('@')[0].replace(/\D/g, '');
                this.lidToPhoneMap[cleanLid] = cleanPn;
                console.log(`[LID Resolver] Mapped ${cleanLid} -> ${cleanPn} via contact.number`);
              }
            } catch (err) {
              // Ignore individual failures
            }
          }
        });
        await Promise.all(fallbackPromises);
      }

      // Also scan all participants to map standard numbers to their own IDs (no-op map just in case)
      participants.forEach(p => {
        const id = p.id._serialized.split('@')[0];
        if (!p.id._serialized.endsWith('@lid')) {
          this.lidToPhoneMap[id] = id.replace(/\D/g, '');
        }
      });

      // Dump the group members list to whatsapp_group_members.json
      try {
        const membersList = participants.map(p => {
          const serialized = p.id._serialized;
          const cleanId = p.id.user;
          const resolvedPhone = this.lidToPhoneMap[cleanId] || (serialized.endsWith('@lid') ? null : cleanId);
          return {
            id: cleanId,
            serialized: serialized,
            resolvedPhone: resolvedPhone,
            isAdmin: p.isAdmin || false,
            isSuperAdmin: p.isSuperAdmin || false
          };
        });

        fs.writeFileSync(
          path.join(__dirname, 'whatsapp_group_members.json'),
          JSON.stringify(membersList, null, 2),
          'utf8'
        );
        console.log(`[LID Resolver] Successfully saved whatsapp_group_members.json with ${membersList.length} participants.`);
      } catch (dumpErr) {
        console.error("[LID Resolver] Failed to save group members dump:", dumpErr.message);
      }

      // Self-heal database and memory cache
      this.emit('lid_mappings_updated', this.lidToPhoneMap);
    } catch (err) {
      console.error("[LID Resolver] Error building LID mapping:", err);
    }
  }

  // Legacy helper interface
  async buildLidMapping() {
    const settings = database.getSettings();
    if (settings.whatsappGroupId) {
      const gids = settings.whatsappGroupId.split(',').map(id => id.trim()).filter(Boolean);
      for (const gid of gids) {
        try {
          const chat = await this.client.getChatById(gid);
          await this.buildLidMappingForChat(chat);
        } catch (e) {
          console.warn(`[LID Resolver] Legacy buildLidMapping failed for ${gid}:`, e.message);
        }
      }
    }
  }

  // Cleanup intervals and client on shutdown
  async destroy() {
    console.log("[Shutdown] Cleaning up intervals...");
    if (this.healthCheckInterval) clearInterval(this.healthCheckInterval);
    if (this.keepAliveInterval) clearInterval(this.keepAliveInterval);
    if (this.client) {
      try {
        console.log("[Shutdown] Gracefully destroying WhatsApp client...");
        await Promise.race([
          this.client.destroy(),
          new Promise((_, reject) => setTimeout(() => reject(new Error("Client destroy timeout")), 10000))
        ]);
        console.log("[Shutdown] WhatsApp client destroyed successfully.");
      } catch (err) {
        console.error("[Shutdown] Error during client destruction:", err.message);
      }
      this.client = null;
    }
  }
}

let isShuttingDown = false;
const gracefulShutdown = async (signal) => {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`\n[Process Shutdown] Received signal: ${signal}. Shutting down WhatsApp client gracefully...`);
  try {
    const manager = module.exports;
    if (manager) {
      await manager.destroy();
    }
    console.log("[Process Shutdown] Graceful shutdown complete.");
  } catch (err) {
    console.error("[Process Shutdown] Error during shutdown:", err.message);
  }
  if (signal === 'SIGUSR2') {
    process.kill(process.pid, 'SIGUSR2');
  } else {
    process.exit(0);
  }
};

process.once('SIGINT', () => gracefulShutdown('SIGINT'));
process.once('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.once('SIGUSR2', () => gracefulShutdown('SIGUSR2'));

module.exports = new WhatsAppManager();
