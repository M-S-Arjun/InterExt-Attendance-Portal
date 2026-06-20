const database = require('./database');

// Standard Levenshtein Distance implementation for fuzzy matching
function levenshteinDistance(s1, s2) {
  const track = Array(s2.length + 1).fill(null).map(() =>
    Array(s1.length + 1).fill(null));
  for (let i = 0; i <= s1.length; i += 1) {
    track[0][i] = i;
  }
  for (let j = 0; j <= s2.length; j += 1) {
    track[j][0] = j;
  }
  for (let j = 1; j <= s2.length; j += 1) {
    for (let i = 1; i <= s1.length; i += 1) {
      const indicator = s1[i - 1] === s2[j - 1] ? 0 : 1;
      track[j][i] = Math.min(
        track[j][i - 1] + 1, // deletion
        track[j - 1][i] + 1, // insertion
        track[j - 1][i - 1] + indicator // substitution
      );
    }
  }
  return track[s2.length][s1.length];
}

// Computes a similarity score between 0.0 and 1.0 with strict word boundary checking
function stringSimilarity(s1, s2) {
  s1 = s1.toLowerCase().trim();
  s2 = s2.toLowerCase().trim();
  
  if (s1 === s2) return 1.0;
  if (s1.length === 0 || s2.length === 0) return 0.0;

  // Substring inclusion bonus with strict word boundary checking
  const escapedS1 = s1.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
  const wordBoundaryRegex = new RegExp(`\\b${escapedS1}\\b`, 'i');
  
  const escapedS2 = s2.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
  const wordBoundaryRegexReverse = new RegExp(`\\b${escapedS2}\\b`, 'i');

  if (wordBoundaryRegex.test(s2) || wordBoundaryRegexReverse.test(s1)) {
    const minLen = Math.min(s1.length, s2.length);
    const maxLen = Math.max(s1.length, s2.length);
    return 0.8 + (minLen / maxLen) * 0.18; // cap at 0.98 for partials
  }

  const distance = levenshteinDistance(s1, s2);
  const maxLength = Math.max(s1.length, s2.length);
  return Number((1.0 - distance / maxLength).toFixed(2));
}

// Spell-corrects a single word using a direct map and fuzzy matching against a target vocabulary.
// Safe-guarded to avoid correcting JID components, employee names, or site names.
function spellCorrectWord(word, employees = [], sites = []) {
  const cleanWord = word.toLowerCase().replace(/[^a-z]/g, '');
  if (cleanWord.length < 3) return word; // too short to correct safely

  const lowerWord = cleanWord.trim();

  // Safeguard: do not spell-correct if the word matches or is very close to an active employee name
  const matchesEmployee = employees.some(e => {
    if (!e || !e.name) return false;
    const nameWords = e.name.toLowerCase().replace(/[^a-z\s]/g, '').split(/\s+/);
    return nameWords.some(nw => nw === lowerWord || levenshteinDistance(nw, lowerWord) <= 1);
  });
  if (matchesEmployee) return word;

  // Safeguard: do not spell-correct if the word matches or is very close to a site name
  const matchesSite = sites.some(s => {
    if (!s || !s.name) return false;
    const siteWords = s.name.toLowerCase().replace(/[^a-z\s]/g, '').split(/\s+/);
    return siteWords.some(sw => sw === lowerWord || levenshteinDistance(sw, lowerWord) <= 1);
  });
  if (matchesSite) return word;

  // Direct manual mappings for common spelling mistakes and abbreviations
  const directMap = {
    // leave keywords
    'leav': 'leave', 'leve': 'leave', 'laeve': 'leave', 'leves': 'leave', 'leavs': 'leave', 'leavin': 'leave', 'leving': 'leave',
    'live': 'leave',
    // half-day keywords
    'haf': 'half', 'haaf': 'half', 'haff': 'half',
    'dey': 'day', 'da': 'day',
    // session / section
    'sesion': 'session', 'seson': 'session', 'secion': 'session', 'seccion': 'session', 'sektion': 'session', 
    'section': 'session', 'sectionn': 'session', 'seccionn': 'session',
    // morning keywords
    'morng': 'morning', 'mornig': 'morning', 'mornng': 'morning', 'mrng': 'morning', 'morining': 'morning', 'mornin': 'morning',
    // afternoon keywords
    'aftrnoon': 'afternoon', 'aftnoon': 'afternoon', 'aftrenoon': 'afternoon', 'afternon': 'afternoon', 'afrnoon': 'afternoon', 'aftn': 'afternoon',
    // evening keywords
    'evng': 'evening', 'eveg': 'evening', 'eveing': 'evening',
    // absent keywords
    'abscent': 'absent', 'abesent': 'absent', 'absend': 'absent',
    // travel keywords
    'travl': 'travel', 'traval': 'travel', 'travelling': 'travel', 'traveling': 'travel', 'travaling': 'travel', 'travalin': 'travel', 'travling': 'travel',
    // hours keywords
    'hour': 'hour', 'hours': 'hours', 'hr': 'hour', 'hrs': 'hours'
  };

  if (directMap[cleanWord]) {
    return directMap[cleanWord];
  }

  // Fuzzy match general keywords using Levenshtein distance
  const KEYWORDS = ['leave', 'half', 'day', 'session', 'morning', 'afternoon', 'evening', 'absent', 'travel', 'hour', 'hours'];
  let bestWord = null;
  let bestDistance = 999;
  for (const kw of KEYWORDS) {
    const dist = levenshteinDistance(cleanWord, kw);
    const maxAllowedDist = kw.length <= 6 ? 1 : 2;
    if (dist <= maxAllowedDist && dist < bestDistance) {
      bestDistance = dist;
      bestWord = kw;
    }
  }

  if (bestWord) {
    return bestWord;
  }

  return word;
}

// Smart, typo-tolerant first-name, initial-based, and space-free matching for employee directory
function smartNameMatch(part, validEmployees) {

  if (!part) return null;
  const cleanPart = part.toLowerCase().trim().replace(/[^a-z\s]/g, '');
  if (cleanPart.length < 2) return null;

  const cleanPartNoSpace = cleanPart.replace(/\s+/g, '');

  let bestEmp = null;
  let bestScore = 0.0;

  // Step 1: Check for exact match or exact space-free match (catches Sunilrana vs Sunil Rana)
  for (const emp of validEmployees) {
    if (!emp || !emp.name) continue;
    const cleanEmpName = emp.name.toLowerCase().trim().replace(/[^a-z\s]/g, '');
    const cleanEmpNameNoSpace = cleanEmpName.replace(/\s+/g, '');

    if (cleanPart === cleanEmpName) {
      return { emp, score: 1.0 };
    }
    if (cleanPartNoSpace === cleanEmpNameNoSpace) {
      return { emp, score: 1.0 };
    }
  }

  // Step 2: Check for initials matching (e.g. "Abhishek S" matches "Abhishek Shaji", "James T" matches "James TM")
  const partWords = cleanPart.split(/\s+/);
  if (partWords.length >= 2) {
    const lastWord = partWords[partWords.length - 1];
    if (lastWord.length === 1) { // Single letter initial!
      const initial = lastWord;
      const mainPart = partWords.slice(0, -1).join(' ');
      const matches = [];

      for (const emp of validEmployees) {
        if (!emp || !emp.name) continue;
        const cleanEmpName = emp.name.toLowerCase().trim().replace(/[^a-z\s]/g, '');
        const empWords = cleanEmpName.split(/\s+/);
        
        if (empWords.length >= 2) {
          const empFirstName = empWords[0];
          const empLastName = empWords[empWords.length - 1];
          const mainEmpPart = empWords.slice(0, -1).join(' ');

          // Check if first name matches mainPart and last name starts with initial
          if (mainEmpPart === mainPart && empLastName.startsWith(initial)) {
            matches.push(emp);
          }
        }
      }

      if (matches.length === 1) {
        return { emp: matches[0], score: 0.98 };
      }
    }
  }

  // Step 3: Check for unique single-word first-name match (e.g. "Anoop", "Aneesh")
  if (partWords.length === 1) {
    const singleWord = partWords[0];
    const matches = [];
    for (const emp of validEmployees) {
      if (!emp || !emp.name) continue;
      const cleanEmpName = emp.name.toLowerCase().trim().replace(/[^a-z\s]/g, '');
      const empWords = cleanEmpName.split(/\s+/);
      if (empWords.includes(singleWord)) {
        matches.push(emp);
      }
    }
    if (matches.length === 1) {
      return { emp: matches[0], score: 0.95 };
    }
  }

  // Step 4: Fuzzy match with space-free typo-tolerance AND first-name comparison (handles Abishek vs Abhishek Shaji)
  for (const emp of validEmployees) {
    if (!emp || !emp.name) continue;
    const cleanEmpName = emp.name.toLowerCase().trim().replace(/[^a-z\s]/g, '');
    const cleanEmpNameNoSpace = cleanEmpName.replace(/\s+/g, '');
    const empWords = cleanEmpName.split(/\s+/);
    const cleanEmpFirstName = empWords[0];

    // Standard string similarity vs full name
    const scoreStandard = stringSimilarity(cleanPart, cleanEmpName);

    // Standard string similarity vs first name
    let scoreFirstName = 0.0;
    if (cleanEmpFirstName) {
      scoreFirstName = stringSimilarity(cleanPart, cleanEmpFirstName);
      // Give a tiny penalty to first-name-only matches if they aren't exact, to prioritize full matches
      if (cleanPart !== cleanEmpFirstName) {
        scoreFirstName -= 0.02;
      }
    }

    // Space-free similarity vs full name (handles Sunilrana vs Sunil Rana)
    let scoreSpaceFree = 0.0;
    if (cleanPartNoSpace.length > 0 && cleanEmpNameNoSpace.length > 0) {
      const distance = levenshteinDistance(cleanPartNoSpace, cleanEmpNameNoSpace);
      const maxLength = Math.max(cleanPartNoSpace.length, cleanEmpNameNoSpace.length);
      scoreSpaceFree = Number((1.0 - distance / maxLength).toFixed(2));
    }

    const score = Math.max(scoreStandard, scoreFirstName, scoreSpaceFree);

    if (score > bestScore) {
      bestScore = score;
      bestEmp = emp;
    }
  }

  if (bestEmp) {
    const bestEmpNameClean = bestEmp.name.replace(/[^a-z]/gi, '').toLowerCase();
    const threshold = Math.min(bestEmpNameClean.length, cleanPartNoSpace.length) <= 5 ? 0.90 : 0.85;
    const finalThreshold = Math.max(bestEmpNameClean.length, cleanPartNoSpace.length) >= 8 ? 0.80 : threshold;

    if (bestScore >= finalThreshold) {
      return { emp: bestEmp, score: bestScore };
    }
  }

  return null;
}

// Helper to convert time strings ("8 AM", "8:30", "5 PM", "17:30") into ISO dates
function parseTimeStr(timeMatchStr, dateStr = null, forceCheckoutPM = false) {
  const clean = timeMatchStr.toLowerCase().trim();
  
  // Try 12-hour AM/PM matching: "8:30 am", "5 pm"
  const ampmRegex = /(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)/i;
  const ampmMatch = clean.match(ampmRegex);
  
  let hours = 0;
  let minutes = 0;
  
  if (ampmMatch) {
    hours = parseInt(ampmMatch[1]);
    minutes = ampmMatch[2] ? parseInt(ampmMatch[2]) : 0;
    const period = ampmMatch[3];
    if (period === 'pm' && hours < 12) hours += 12;
    if (period === 'am' && hours === 12) hours = 0;
  } else {
    // Try 24-hour digit/simple integer matching: "08:30", "17:00", "8", "5"
    const hrMinRegex = /(\d{1,2})(?:[:.](\d{2}))?/i;
    const hrMinMatch = clean.match(hrMinRegex);
    if (hrMinMatch) {
      hours = parseInt(hrMinMatch[1]);
      minutes = hrMinMatch[2] ? parseInt(hrMinMatch[2]) : 0;
      
      // PM Heuristic: 
      // If no AM/PM is specified and hours is 1 to 6 (e.g. check-out at "5"),
      // or if forceCheckoutPM is flagged (representing a checkout slot), auto-assume PM!
      if (hours >= 1 && hours <= 6) {
        hours += 12;
      } else if (forceCheckoutPM && hours > 6 && hours < 12) {
        // e.g. checking out at "7" or "8" is likely PM (7:00 PM) for late shifts
        hours += 12;
      }
    }
  }
  
  const d = new Date();
  if (dateStr) {
    const parts = dateStr.split('-');
    d.setFullYear(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
  }
  d.setHours(hours, minutes, 0, 0);
  return d.toISOString();
}

// Helper to extract target dates (in YYYY-MM-DD format) from message text
function extractTargetDates(text, messageTimestamp = null) {
  const refDate = messageTimestamp ? new Date(messageTimestamp) : new Date();
  
  // Format Date to YYYY-MM-DD
  const formatDate = (dateObj) => {
    const y = dateObj.getFullYear();
    const m = String(dateObj.getMonth() + 1).padStart(2, '0');
    const d = String(dateObj.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  };

  const todayStr = formatDate(refDate);
  
  const yesterday = new Date(refDate);
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStr = formatDate(yesterday);

  const tomorrow = new Date(refDate);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowStr = formatDate(tomorrow);

  const dayBeforeYesterday = new Date(refDate);
  dayBeforeYesterday.setDate(dayBeforeYesterday.getDate() - 2);
  const dayBeforeYesterdayStr = formatDate(dayBeforeYesterday);

  // Check for explicit date matches first, e.g. "25/05/2026", "25-05-2026", "25/05"
  const explicitDates = [];
  const fullDateRegex = /\b(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})\b/g;
  let match;
  while ((match = fullDateRegex.exec(text)) !== null) {
    let day = parseInt(match[1]);
    let month = parseInt(match[2]);
    let year = parseInt(match[3]);
    if (year < 100) year += 2000;
    const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    explicitDates.push(dateStr);
  }

  if (explicitDates.length > 0) {
    return [...new Set(explicitDates)].sort();
  }

  // Fallback: Check for semantic / relative date keywords
  const cleanText = text.toLowerCase().trim();
  const dates = new Set();

  const hasYesterday = /\b(?:yesterday|innale|y'day|yday)\b/i.test(cleanText);
  const hasToday = /\b(?:today|innu)\b/i.test(cleanText);
  const hasTomorrow = /\b(?:tomorrow|nale|tmrw|tmrow)\b/i.test(cleanText);
  const hasDayBeforeYesterday = /\b(?:day\s+before\s+yesterday|munninale|minnannu)\b/i.test(cleanText);

  if (hasYesterday) {
    dates.add(yesterdayStr);
  }
  if (hasToday) {
    dates.add(todayStr);
  }
  if (hasTomorrow) {
    dates.add(tomorrowStr);
  }
  if (hasDayBeforeYesterday) {
    dates.add(dayBeforeYesterdayStr);
  }

  // If no relative indicators are present, default to today
  if (dates.size === 0) {
    dates.add(todayStr);
  }

  return Array.from(dates).sort();
}

class AttendanceParser {
  // Known Indian place names - to prevent confusion with employee names
  static INDIAN_PLACE_NAMES = new Set([
    'kochi', 'kottayam', 'thodupuzha', 'muvattupuzha', 'vazhakulam', 'vengalloor', 
    'kothamangalam', 'thrissur', 'ernakulam', 'idukki', 'wayanad', 'malappuram',
    'kannur', 'kasaragod', 'kollam', 'pathanamthitta', 'alappuzha', 'thiruvananthapuram',
    'palakkad', 'thiruvananthapuram', 'cochin', 'trivandrum', 'coimbatore', 'bangalore',
    'mangalore', 'calicut', 'kozhikode', 'mattancherry', 'fort kochi', 'munnar',
    'vagamon', 'thekkady', 'varkala', 'alleppey', 'kumarakom', 'backwaters', 'kerala',
    'cavili', 'choondi', 'chamakkala', 'raju joseph', 'joseph'
  ]);

  // Helper to robustly classify leaves semantically
  detectIsLeave(line) {
    const clean = line.toLowerCase().trim();
    const leavePhrases = [
      'on leave', 'leave today', 'leave tomorrow', 'taking leave', 'casual leave', 
      'sick leave', 'hospital case leave', 'cl', 'sl', 'el', 'pl',
      'not coming', 'not coming today', 'not available', 'absent today', 'taking off', 
      'day off', 'off today', 'not able to come', 'not able to attend', 'not reaching today',
      'cannot come', 'can\'t come', 'cant come', 'unable to come', 'unable to reach', 'unable to attend',
      'won\'t be coming', 'wont be coming', 'won\'t come', 'wont come', 'will not come', 'will not be coming',
      'not reporting', 'not reporting today',
      'not well', 'unwell', 'not feeling well', 'sick', 'sickness', 'ill', 'illness', 'fever', 'headache',
      'family function', 'family issue', 'family emergency', 'personal work', 'personal issue', 'personal emergency',
      'urgent work', 'urgent matter', 'rest today', 'taking rest', 'need rest',
      // Malayalam transliterated terms
      'innu varilla', 'varilla', 'varan kazhiyilla', 'varan patilla', 'innu leave', 'leave aanu', 'leave aane', 
      'panayanu', 'paniyanu', 'panidirunnu', 'panidirunu', 'pani aane', 'pani aanu'
    ];

    const matchesPhrase = leavePhrases.some(phrase => {
      const escaped = phrase.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
      const regex = new RegExp(`\\b${escaped}\\b`, 'i');
      return regex.test(clean);
    });
    const matchesRegex = /\b(?:leave|sick|sickness|unwell|fever|headache|absent|off|cl|sl|el|pl|varilla)\b/i.test(clean);

    if (matchesPhrase || matchesRegex) {
      // Safeguard: Make sure this is not a check-in message mentioning a past leave
      const containsTime = /\b\d{1,2}[:.]\d{2}\s*(?:am|pm)?\b/i.test(clean);
      const containsCheckInLabel = /\b(?:check-in|checkin|in\s*:|checkout|check-out|out\s*:)/i.test(clean);
      if (containsTime && containsCheckInLabel) {
        return false;
      }
      return true;
    }
    return false;
  }

  detectIsHalfDayLeave(line) {
    const clean = line.toLowerCase().trim();

    // --- Tier 1: Explicit "half day" phrases (exact and misspelled) ---
    const halfDayExplicit = [
      /\bhalf[-\s]*day\b/i,
      /\bhaf[-\s]*day\b/i,          // typo: haf day
      /\bhaalf[-\s]*day\b/i,         // typo: haalf day
      /\bhalf[-\s]*dey\b/i,          // typo: half dey
      /\bh[- ]?day\b/i,              // abbreviation: h-day
    ];
    const isHalfDayExplicit = halfDayExplicit.some(r => r.test(clean));
    const hasLeaveSignal = /\b(?:leave|off|absent|rest|not coming|unable to come|cannot come|can't come|cannot attend|wont come|will not come|sick|unwell|hospital|varilla|kazhiyilla)\b/i.test(clean);
    if (isHalfDayExplicit && hasLeaveSignal) return true;

    // --- Tier 2: Session-based patterns ---
    // Matches: "leave afternoon session", "on leave for afternoon", "leave evening",
    //          "morning leave", "first half leave", "second half absent", etc.
    const sessionHalfDayPatterns = [
      // Afternoon / evening / post-lunch = second half leave
      /\b(?:leave|absent|off|not\s+coming|cant\s+come|cannot\s+come|wont\s+come)\b.{0,40}\b(?:afternoon|evening|post[-\s]*lunch|second[-\s]*half|2nd[-\s]*half|lunch\s*break\s*onwards|after\s*lunch)\b/i,
      /\b(?:afternoon|evening|post[-\s]*lunch|second[-\s]*half|2nd[-\s]*half|after\s*lunch)\b.{0,40}\b(?:leave|absent|off|not\s+coming|only)\b/i,
      /\bon\s+leave\s+(?:for\s+)?(?:the\s+)?afternoon/i,
      /\bon\s+leave\s+(?:for\s+)?(?:the\s+)?evening/i,
      /\bafternoon\s+session\b.{0,20}(?:leave|absent|off)/i,
      /\b(?:leave|absent|off)\b.{0,20}\bafternoon\s+session\b/i,
      /\bleave\s+after\s+(?:lunch|noon|12|1\s*pm|one\s*pm)/i,
      // Morning / first half leave
      /\b(?:leave|absent|off|not\s+coming|cant\s+come|cannot\s+come|wont\s+come)\b.{0,40}\b(?:morning|first[-\s]*half|1st[-\s]*half|before\s*lunch|forenoon|am\s*session)\b/i,
      /\b(?:morning|first[-\s]*half|1st[-\s]*half|before\s*lunch|forenoon|am\s*session)\b.{0,40}\b(?:leave|absent|off|not\s+coming|only)\b/i,
      /\bon\s+leave\s+(?:for\s+)?(?:the\s+)?morning/i,
      /\bmorning\s+session\b.{0,20}(?:leave|absent|off)/i,
      /\b(?:leave|absent|off)\b.{0,20}\bmorning\s+session\b/i,
      // Generic "leave for [session]" / "[session] leave"
      /\bonly\s+(?:half|morning|afternoon|evening|first|second)\b.{0,20}(?:leave|absent|off|available|present)/i,
      /\bhalf\s+(?:leave|day\s+leave|day\s+absent)\b/i,
      // Malayalam transliterations for half-day
      /\bharth\s*day\b/i,  // accent variation
      /\bhalf\s*da\b/i,    // abbreviated
      /\boru\s+session/i,  // "one session" in Malayalam-English
      /\b(?:leave|absent)\s+(?:oru|one)\s+session/i,
    ];
    if (sessionHalfDayPatterns.some(r => r.test(clean))) return true;

    // --- Tier 3: Semantic intent patterns - words together imply partial absence ---
    // e.g. "I will be absent in the afternoon", "not coming for evening"
    const semanticPatterns = [
      /\bnot\s+(?:coming|available|present)\s+(?:for\s+)?(?:the\s+)?(?:afternoon|evening|morning)/i,
      /\b(?:afternoon|morning|evening)\s+(?:session|work|shift)\s+(?:leave|absent|off)/i,
      /\bworking\s+only\s+(?:morning|half|afternoon|till\s+noon)/i,
      /\bleaving\s+at\s+(?:noon|lunch|1\s*pm|12\s*pm|one\s*pm|twelve)/i,
      /\bwill\s+(?:be\s+)?(?:available|come|present)\s+only\s+(?:in\s+the\s+)?(?:morning|afternoon)/i,
      /\bcoming\s+only\s+(?:for\s+)?(?:morning|afternoon|half)/i,
    ];
    if (semanticPatterns.some(r => r.test(clean))) return true;

    return false;
  }

  /**
   * Detect whether the half-day leave is for the FIRST half (morning) or SECOND half (afternoon).
   * Returns 'first' or 'second'. Defaults to 'second' if ambiguous.
   */
  detectHalfDayPeriod(line) {
    const clean = line.toLowerCase().trim();

    // Signals that indicate FIRST half (morning leave)
    const firstHalfSignals = [
      /\b(?:morning|first[-\s]*half|1st[-\s]*half|before\s*lunch|forenoon|am\s*session)\b/i,
      /\bnot\s+(?:coming|available|present)\s+(?:in\s+)?(?:the\s+)?morning/i,
      /\bmorning\s+session\b.{0,30}(?:leave|absent|off)/i,
      /\bleave\s+(?:in\s+)?(?:the\s+)?morning/i,
    ];
    if (firstHalfSignals.some(r => r.test(clean))) return 'first';

    // Signals that indicate SECOND half (afternoon/evening leave) — also the default
    const secondHalfSignals = [
      /\b(?:afternoon|evening|post[-\s]*lunch|second[-\s]*half|2nd[-\s]*half|after\s*lunch|pm\s*session)\b/i,
      /\bnot\s+(?:coming|available|present)\s+(?:in\s+)?(?:the\s+)?afternoon/i,
      /\bafternoon\s+session\b/i,
      /\bleave\s+(?:in\s+)?(?:the\s+)?afternoon/i,
    ];
    if (secondHalfSignals.some(r => r.test(clean))) return 'second';

    // Default: treat ambiguous half-day as second half (afternoon)
    return 'second';
  }

  // Parse a single text line/message
  parseSingleLine(cleanLine, dateStr = null, defaultSiteObj = null, rawSender = "", messageTimestamp = null) {
    const isHalfDayLeave = this.detectIsHalfDayLeave(cleanLine);
    const isLeave = isHalfDayLeave || this.detectIsLeave(cleanLine);
    const employees = (database.getEmployees() || []).filter(e => e && e.status === 'active');
    const sites = (database.getSites() || []).filter(s => s && s.name);

    // 1. Detect Work Site FIRST - Prioritize place names
    let matchedSite = defaultSiteObj || null;
    let siteConfidence = defaultSiteObj ? 1.0 : 0.0;
    let extractedSite = defaultSiteObj ? defaultSiteObj.name : "";

    // Try exact substring match for sites first
    const exactSiteSub = sites
      .map(s => ({ site: s, idx: cleanLine.toLowerCase().indexOf(s.name.toLowerCase()) }))
      .filter(res => res.idx >= 0)
      .sort((a, b) => b.site.name.length - a.site.name.length);

    if (exactSiteSub.length > 0) {
      matchedSite = exactSiteSub[0].site;
      siteConfidence = 1.0;
      extractedSite = matchedSite.name;
    }

    // 2. Detect Worker - but AVOID matching known place names as employees
    let matchedEmployee = null;
    let employeeConfidence = 0.0;
    let extractedName = "";

    // Filter out employees that are actually known place names
    let validEmployees = employees.filter(e => 
      e && e.name && !AttendanceParser.INDIAN_PLACE_NAMES.has(e.name.toLowerCase())
    );

    // Apply supervisor vs office worker rules for Akhil and Anandhu/Ananthu
    const containsAkhil = /\bakhil\b/i.test(cleanLine);
    const containsAnandhu = /\b(anandhu|ananthu)\b/i.test(cleanLine);

    if (containsAkhil) {
      const cleanSender = rawSender ? rawSender.replace(/\D/g, '') : "";
      if (cleanSender === '918921773873' && isLeave) {
        // Office worker Akhil P Kumar reporting leave
        validEmployees = validEmployees.filter(e => e.id !== 'emp_IN063');
      } else {
        // Supervisor report for Akhil A K
        validEmployees = validEmployees.filter(e => e.id !== 'emp_2006');
      }
    }

    if (containsAnandhu) {
      const cleanSender = rawSender ? rawSender.replace(/\D/g, '') : "";
      if (cleanSender === '917558835311' && isLeave) {
        // Office worker Anandhu Sunil reporting leave
        validEmployees = validEmployees.filter(e => e.id !== 'emp_IN064');
      } else {
        // Supervisor report for Anandhu Raj
        validEmployees = validEmployees.filter(e => e.id !== 'emp_2029');
      }
    }

    // Clean nameLine to isolate the worker name
    let nameLineClean = cleanLine.toLowerCase();
    // Strip time ranges (e.g. 9-6, 9 to 6, 9:30 to 6:00)
    nameLineClean = nameLineClean.replace(/\b\d{1,2}(?::\d{2})?(?:\s*(?:am|pm))?\s*(?:to|-)\s*\d{1,2}(?::\d{2})?(?:\s*(?:am|pm))?\b/gi, '');
    // Strip standard standalone times with am/pm (e.g. 9am, 5pm)
    nameLineClean = nameLineClean.replace(/\b\d{1,2}\s*(?:am|pm)\b/gi, '');
    // Strip remaining standalone numbers (e.g. 9, 6)
    nameLineClean = nameLineClean.replace(/\b\d{1,2}\b/g, '');
    
    // Strip standard keywords
    const keywords = ['in', 'out', 'checkout', 'checkin', 'check-in', 'check-out', 'left', 'leave', 'exit', 'finish', 'done', 'leaving', 'present', 'absent'];
    keywords.forEach(kw => {
      nameLineClean = nameLineClean.replace(new RegExp('\\b' + kw + '\\b', 'gi'), '');
    });
    
    // Strip known site name words to isolate employee name
    sites.forEach(s => {
      if (s && s.name) {
        s.name.toLowerCase().split(/\s+/).forEach(word => {
          if (word.length > 2 && word !== 'the' && word !== 'and') {
            nameLineClean = nameLineClean.replace(new RegExp('\\b' + word + '\\b', 'gi'), '');
          }
        });
      }
    });
    
    // Clean up punctuation and spacing
    nameLineClean = nameLineClean.replace(/[()]/g, ' ').replace(/\s+/g, ' ').trim();

    // Try exact substring first (e.g. "Maya Sunil" in the line)
    const exactSub = validEmployees
      .map(e => ({ emp: e, idx: cleanLine.toLowerCase().indexOf(e.name.toLowerCase()) }))
      .filter(res => res.idx >= 0)
      .sort((a, b) => b.emp.name.length - a.emp.name.length); // longest name match first

    if (exactSub.length > 0) {
      matchedEmployee = exactSub[0].emp;
      employeeConfidence = 1.0;
      extractedName = matchedEmployee.name;
    }

    // Try smart name matching on delimiters split of nameLineClean
    const delimiters = /[,;\-|:]/;
    const parts = nameLineClean.split(delimiters).map(p => p.trim()).filter(p => p.length > 0);

    if (!matchedEmployee && parts.length > 0) {
      let bestMatch = null;
      let bestMatchPart = "";

      for (const part of parts) {
        if (!part) continue;
        const res = smartNameMatch(part, validEmployees);
        if (res && (!bestMatch || res.score > bestMatch.score)) {
          bestMatch = res;
          bestMatchPart = part;
        }
      }

      if (bestMatch) {
        matchedEmployee = bestMatch.emp;
        employeeConfidence = bestMatch.score;
        extractedName = bestMatchPart;
      }
    }

    // Fallback: if name still not matched, check parts of the original cleanLine
    if (!matchedEmployee) {
      const origParts = cleanLine.split(delimiters).map(p => p.trim()).filter(p => p.length > 0);
      let bestMatch = null;
      let bestMatchPart = "";

      for (const part of origParts) {
        if (!part) continue;
        const res = smartNameMatch(part, validEmployees);
        if (res && (!bestMatch || res.score > bestMatch.score)) {
          bestMatch = res;
          bestMatchPart = part;
        }
      }

      if (bestMatch) {
        matchedEmployee = bestMatch.emp;
        employeeConfidence = bestMatch.score;
        extractedName = bestMatchPart;
      }
    }

    // Check sender phone mapping if rawSender is provided
    if (rawSender) {
      const cleanSender = rawSender.replace(/\D/g, '');
      if (cleanSender) {
        const phoneMatchedEmployee = validEmployees.find(e => e.phone && e.phone.replace(/\D/g, '') === cleanSender);
        if (phoneMatchedEmployee) {
          // If no employee was matched in the text, or if the text match is weak (confidence < 0.95)
          // ONLY override if the matched name is close to the phone-matched name, to prevent supervisors from overriding reported workers
          let shouldOverride = !matchedEmployee;
          if (matchedEmployee && employeeConfidence < 0.95) {
            const similarity = stringSimilarity(matchedEmployee.name, phoneMatchedEmployee.name);
            if (similarity >= 0.60) {
              shouldOverride = true;
            }
          }
          if (shouldOverride) {
            matchedEmployee = phoneMatchedEmployee;
            employeeConfidence = 1.0;
            extractedName = phoneMatchedEmployee.name;
          }
        }
      }
    }

    if (!matchedSite && parts.length > 0) {
      let bestSite = null;
      let bestSiteScore = 0.0;
      let bestSitePart = "";

      parts.forEach(part => {
        if (!part) return;
        sites.forEach(site => {
          if (!site || !site.name) return;
          const score = stringSimilarity(part, site.name);
          if (score > bestSiteScore) {
            bestSiteScore = score;
            bestSite = site;
            bestSitePart = part;
          }
        });
      });

      if (bestSite && bestSiteScore >= 0.70) {
        matchedSite = bestSite;
        siteConfidence = bestSiteScore;
        extractedSite = bestSitePart;
      }
    }

    // Extract site from delimiters fallback if matchedSite is still null (skip for leaves)
    let hasFallbackLocation = false;
    if (!isLeave && !matchedSite && parts.length > 0) {
      // If we matched an employee, we can check parts[0] as a site candidate, unless parts[0] contains the matched employee's name.
      // If we did not match an employee, we must skip parts[0] because it is the unrecognized employee name.
      const startIndex = matchedEmployee
        ? (parts[0] && parts[0].toLowerCase().includes(matchedEmployee.name.toLowerCase().split(' ')[0]) ? 1 : 0)
        : 1;

      if (parts.length > startIndex) {
        const locationPart = parts.slice(startIndex).find(part => {
          if (!part) return false;
          const p = part.toLowerCase().trim();
          if (p === '—' || p === '' || p === '-') return false;
          
          // If the part is ONLY digits/time-range/parentheses/punctuation, reject it
          const hasTimeOnly = p.match(/^\s*[()\d\s\-:apmto—.,]+\s*$/i);
          if (hasTimeOnly) return false;

          return !p.match(/\b(in|out|check|name)\b/) && p.trim() !== 'site';
        });
        if (locationPart) {
          // Clean any time ranges, digits, or parentheses from the extracted site
          let cleanedLocation = locationPart
            .replace(/\b\d{1,2}(?::\d{2})?(?:\s*(?:am|pm))?\s*(?:to|-)\s*\d{1,2}(?::\d{2})?(?:\s*(?:am|pm))?\b/i, '')
            .replace(/[()]/g, '')
            .trim();

          if (cleanedLocation.length > 0) {
            // Strip leading/trailing slashes, dots, dashes, and other non-alphanumeric punctuation
            cleanedLocation = cleanedLocation.replace(/^[^a-zA-Z0-9]+|[^a-zA-Z0-9]+$/g, '').trim();
          }

          if (cleanedLocation.length > 0) {
            const lowerLoc = cleanedLocation.toLowerCase();
            const hasSentenceIndicator = /\b(am|will|shall|be|reach|late|early|today|tomorrow|yesterday|going|coming|reached|started|due|because|have|has|had|to|for|with|from|good|morning|afternoon|evening|night|hello|hi|sir|mints|mnts|minute|minutes|hour|hours|hr|hrs|on)\b/i.test(lowerLoc);
            const wordCount = cleanedLocation.split(/\s+/).length;

            if (!hasSentenceIndicator && cleanedLocation.length <= 35 && wordCount <= 5) {
              extractedSite = cleanedLocation.split(/\s+/).map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
              hasFallbackLocation = true;
            }
          }
        }
      }
    }

    // Heuristics mapping for site fallbacks if missing completely
    if (!matchedSite && !hasFallbackLocation) {
      if (matchedEmployee && matchedEmployee.siteId) {
        const defSite = sites.find(s => s && (s.id === matchedEmployee.siteId || s.name === matchedEmployee.siteId));
        if (defSite) {
          matchedSite = defSite;
          siteConfidence = 0.5;
          extractedSite = defSite.name;
        }
      }
      if (!matchedSite && sites.length === 1 && sites[0]) {
        matchedSite = sites[0];
        siteConfidence = 0.5;
        extractedSite = sites[0].name;
      }
    }

    // 4. Leave & Time Range / Late check-in extraction
    // NOTE: detectIsHalfDayLeave is evaluated independently — some half-day patterns
    // (e.g. "leave afternoon session") imply leave AND half-day simultaneously, so we
    // detect half-day FIRST, then fall back to full-leave if not half-day.
    const halfDayPeriod = isHalfDayLeave ? this.detectHalfDayPeriod(cleanLine) : null;
    // If message is already identified as half-day, we still confirm it has a leave signal

    let checkInTimestamp = null;
    let checkOutTimestamp = null;
    let breakStartTimestamp = null;
    let breakEndTimestamp = null;
    let actionType = 'in';
    let hasParsedLate = false;
    let hasParsedEarly = false;
    let isHospitalCase = false;
    let hospitalHours = 0;

    if (isLeave) {
      actionType = isHalfDayLeave ? 'half-day-leave' : 'leave';
    } else {
      // Check for Late pattern
      const lateMatch1 = cleanLine.match(/\b(\d+\s+\d+\/\d+|\d+\/\d+|\d+(?:\.\d+)?|one|two|three|four|half)\s*(?:an\s*)?(?:hour|hours|hr|hrs)?\s*late\b/i);
      const lateMatch2 = cleanLine.match(/\blate\s*(?:by\s*)?(\d+\s+\d+\/\d+|\d+\/\d+|\d+(?:\.\d+)?|one|two|three|four|half)\s*(?:an\s*)?(?:hour|hours|hr|hrs)?\b/i);
      const lateMinMatch = cleanLine.match(/(?:(\d+(?:\.\d+)?)\s*(?:minute|minutes|min|mins)\s*late|late\s*(?:by\s*)?(\d+(?:\.\d+)?)\s*(?:minute|minutes|min|mins))/i);
      
      // Check for Early Exit pattern
      const earlyMatch = cleanLine.match(/\b(\d+\s+\d+\/\d+|\d+\/\d+|\d+(?:\.\d+)?|one|two|three|four|half)\s*(?:an\s*)?(?:hour|hours|hr|hrs)?\s*(?:early\s*exit|early\s*leave|early)\b/i);

      const wordToNumber = { 'one': 1, 'two': 2, 'three': 3, 'four': 4, 'half': 0.5 };
      const parseHoursVal = (val) => {
        const cleanVal = val.toLowerCase().trim();
        if (wordToNumber[cleanVal] !== undefined) return wordToNumber[cleanVal];
        if (cleanVal.includes('/')) {
          if (/\d+\s+\d+\/\d+/.test(cleanVal)) {
            const parts = cleanVal.split(/\s+/);
            const whole = parseFloat(parts[0]);
            const [num, den] = parts[1].split('/').map(Number);
            return whole + (den ? num / den : 0);
          } else {
            const [num, den] = cleanVal.split('/').map(Number);
            return den ? num / den : 0;
          }
        }
        return parseFloat(cleanVal);
      };

      let matchedLate = lateMatch1 || lateMatch2;
      isHospitalCase = /\bhospital\b/i.test(cleanLine);

      if (matchedLate) {
        const valStr = matchedLate[1];
        const lateHours = parseHoursVal(valStr);
        if (!isNaN(lateHours)) {
          let shiftStart = (matchedEmployee && matchedEmployee.shiftStart) ? matchedEmployee.shiftStart : "09:00";
          if (!shiftStart || !shiftStart.includes(':')) {
            shiftStart = "09:00";
          }
          const [sh, sm] = shiftStart.split(':').map(Number);
          let hours = sh + Math.floor(lateHours);
          let minutes = sm + Math.round((lateHours % 1) * 60);
          if (minutes >= 60) {
            hours += 1;
            minutes -= 60;
          }
          
          const d = new Date();
          if (dateStr) {
            const parts = dateStr.split('-');
            d.setFullYear(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
          }
          d.setHours(hours, minutes, 0, 0);
          checkInTimestamp = d.toISOString();
          actionType = 'in';
          hasParsedLate = true;
          if (isHospitalCase) {
            hospitalHours = lateHours;
          }
        }
      } else if (lateMinMatch) {
        const valStr = lateMinMatch[1] || lateMinMatch[2];
        const lateMins = parseFloat(valStr);
        if (!isNaN(lateMins)) {
          let shiftStart = (matchedEmployee && matchedEmployee.shiftStart) ? matchedEmployee.shiftStart : "09:00";
          if (!shiftStart || !shiftStart.includes(':')) {
            shiftStart = "09:00";
          }
          const [sh, sm] = shiftStart.split(':').map(Number);
          let hours = sh;
          let minutes = sm + lateMins;
          while (minutes >= 60) {
            hours += 1;
            minutes -= 60;
          }
          
          const d = new Date();
          if (dateStr) {
            const parts = dateStr.split('-');
            d.setFullYear(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
          }
          d.setHours(hours, minutes, 0, 0);
          checkInTimestamp = d.toISOString();
          actionType = 'in';
          hasParsedLate = true;
          if (isHospitalCase) {
            hospitalHours = Number((lateMins / 60).toFixed(2));
          }
        }
      } else if (cleanLine.match(/\blate\b/i)) {
        hasParsedLate = true;
        actionType = 'in';
        let shiftStart = (matchedEmployee && matchedEmployee.shiftStart) ? matchedEmployee.shiftStart : "09:00";
        if (!shiftStart || !shiftStart.includes(':')) {
          shiftStart = "09:00";
        }
        const [sh, sm] = shiftStart.split(':').map(Number);
        const d = new Date();
        if (dateStr) {
          const parts = dateStr.split('-');
          d.setFullYear(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
        }
        d.setHours(sh + 1, sm, 0, 0);
        checkInTimestamp = d.toISOString();
        if (isHospitalCase) {
          hospitalHours = 1;
        }
      } else if (earlyMatch) {
        const valStr = earlyMatch[1];
        const earlyHours = parseHoursVal(valStr);
        if (!isNaN(earlyHours)) {
          let shiftEnd = (matchedEmployee && matchedEmployee.shiftEnd) ? matchedEmployee.shiftEnd : "17:00";
          if (!shiftEnd || !shiftEnd.includes(':')) {
            shiftEnd = "17:00";
          }
          const [eh, em] = shiftEnd.split(':').map(Number);
          let hours = eh - Math.floor(earlyHours);
          let minutes = em - Math.round((earlyHours % 1) * 60);
          if (minutes < 0) {
            hours -= 1;
            minutes += 60;
          }
          
          const d = new Date();
          if (dateStr) {
            const parts = dateStr.split('-');
            d.setFullYear(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
          }
          d.setHours(hours, minutes, 0, 0);
          checkOutTimestamp = d.toISOString();
          actionType = 'out';
          hasParsedEarly = true;
          if (isHospitalCase) {
            hospitalHours = earlyHours;
          }
        }
      }

      // Perform time matching on cleanLine without the late/early phrase to prevent matching duration numbers
      let lineForTimeMatching = cleanLine;
      if (matchedLate) {
        lineForTimeMatching = cleanLine.replace(matchedLate[0], '');
      } else if (lateMinMatch) {
        lineForTimeMatching = cleanLine.replace(lateMinMatch[0], '');
      } else if (earlyMatch) {
        lineForTimeMatching = cleanLine.replace(earlyMatch[0], '');
      }
      // Remove explicit dates to prevent date numbers from being parsed as hours (e.g. "17" in "17/06/26")
      lineForTimeMatching = lineForTimeMatching.replace(/\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b/g, '');
      lineForTimeMatching = lineForTimeMatching.replace(/\b\d{1,2}\/\d{1,2}\b/g, '');
      
      const timeRegex = /\b(\d{1,2}(?:[:.]\d{2})?\s*(?:am|pm)?)\b/gi;
      const timeMatches = lineForTimeMatching.match(timeRegex) || [];

      const lunchRangePattern = /\b(?:1(?:[:.]\d{2})?\s*(?:am|pm)?|one(?:\s*pm)?)\s*(?:to|-)\s*(?:2(?:[:.]\d{2})?\s*(?:am|pm)?|two(?:\s*pm)?)\b/i;
      const lunchOutKeywords = /\b(?:out|left|exit|lunch|break|away)\b/i;
      const isLunchBreak = lunchRangePattern.test(cleanLine) && lunchOutKeywords.test(cleanLine);
      if (isLunchBreak) {
        actionType = 'out-for-lunch';
        if (timeMatches.length >= 2) {
          try {
            breakStartTimestamp = parseTimeStr(timeMatches[0], dateStr, false);
            breakEndTimestamp = parseTimeStr(timeMatches[1], dateStr, true);
          } catch (err) {
            console.error("Lunch break time parsing failed:", err);
          }
        }
      }

      if (timeMatches.length >= 2 && actionType !== 'out-for-lunch' && actionType !== 'half-day-leave') {
        try {
          checkInTimestamp = parseTimeStr(timeMatches[0], dateStr, false);
          checkOutTimestamp = parseTimeStr(timeMatches[1], dateStr, true);
          actionType = 'completed';
        } catch (err) {
          console.error("Time range parsing failed:", err);
        }
      } else if (timeMatches.length === 1 && actionType !== 'half-day-leave' && actionType !== 'out-for-lunch') {
        const outKeywords = ['out', 'checkout', 'check-out', 'left', 'exit', 'finish', 'done', 'leaving'];
        const foundOut = outKeywords.some(kw => new RegExp(`\\b${kw}\\b`, 'i').test(lineForTimeMatching));
        try {
          const timestamp = parseTimeStr(timeMatches[0], dateStr, foundOut);
          if (foundOut) {
            checkOutTimestamp = timestamp;
            actionType = 'out';
          } else {
            checkInTimestamp = timestamp;
            actionType = 'in';
          }
        } catch (err) {
          console.error("Single time parsing failed:", err);
        }
      } else {
        // No times matched. If we didn't parse a late pattern, default to message/current timestamp
        if (!hasParsedLate) {
          const outKeywords = ['out', 'checkout', 'check-out', 'left', 'exit', 'finish', 'done', 'leaving'];
          const foundOut = outKeywords.some(kw => new RegExp(`\\b${kw}\\b`, 'i').test(lineForTimeMatching));
          const timestamp = messageTimestamp ? new Date(messageTimestamp).toISOString() : new Date().toISOString();
          if (foundOut) {
            checkOutTimestamp = timestamp;
            actionType = 'out';
          } else {
            checkInTimestamp = timestamp;
            actionType = 'in';
          }
        }
      }
    }

    let leaveDate = null;
    if (actionType === 'leave' || actionType === 'half-day-leave') {
      leaveDate = dateStr;
    }

    const isSuccess = !!(matchedEmployee && (actionType === 'leave' || actionType === 'half-day-leave' || actionType === 'out-for-lunch' || matchedSite || (extractedSite && extractedSite !== "—")));
    let reason = "";
    if (!matchedEmployee) reason = "Worker name unrecognized";
    else if (actionType !== 'leave' && !matchedSite && (!extractedSite || extractedSite === "—")) reason = "Work site not specified/recognized";

    return {
      isSuccess,
      reason,
      matchedEmployeeId: matchedEmployee ? matchedEmployee.id : null,
      matchedSiteId: matchedSite ? matchedSite.id : null,
      extractedName: extractedName || parts[0] || cleanLine.substring(0, 15),
      extractedSite: (actionType === 'leave' || actionType === 'half-day-leave') && (!extractedSite || extractedSite === "—") ? "—" : (extractedSite || "—"),
      extractedAction: actionType,
      checkInTime: checkInTimestamp,
      checkOutTime: checkOutTimestamp,
      leaveDate: leaveDate,
      breakStart: breakStartTimestamp,
      breakEnd: breakEndTimestamp,
      confidence: Number(((employeeConfidence + siteConfidence) / 2).toFixed(2)),
      isLate: hasParsedLate,
      isHospitalCase: isHospitalCase && (hasParsedLate || hasParsedEarly),
      hospitalHours: hospitalHours,
      halfDayPeriod: halfDayPeriod   // 'first' | 'second' | null
    };
  }

  // Parses a single worker's details spanned over multiple lines
  parseSingleWorkerMultiLine(lines, dateStr, defaultSiteObj, rawSender) {
    let name = "";
    let siteName = "";
    let checkInStr = "";
    let checkOutStr = "";
    
    // Find the first line that is not a site/in/out header as fallback name
    const nonHeaderLine = lines.find(line => {
      const l = line.toLowerCase();
      return !l.startsWith("site:") && !l.includes("site :") &&
             !l.startsWith("in:") && !l.includes("in :") &&
             !l.startsWith("out:") && !l.includes("out :") &&
             !l.startsWith("check-in") && !l.startsWith("check-out") &&
             !l.startsWith("checkin") && !l.startsWith("checkout");
    });
    if (nonHeaderLine) {
      name = nonHeaderLine.trim();
    }
    
    lines.forEach((line, index) => {
      const cleanLine = line.trim();
      const lower = cleanLine.toLowerCase();
      
      // Parse Site
      const siteMatch = cleanLine.match(/site\s*:\s*(.*)/i);
      if (siteMatch) {
        siteName = siteMatch[1].trim();
      } else if (index > 0 && !lower.includes("in:") && !lower.includes("out:") &&
                 !lower.includes("check-in") && !lower.includes("check-out") &&
                 !lower.includes("checkin") && !lower.includes("checkout") &&
                 !lower.includes("name:") && !cleanLine.match(/\d/)) {
        // Fallback for unlabeled location lines like "Vazhakulam"
        siteName = cleanLine;
      }
      
      // Parse Check-in Time
      const inMatch = cleanLine.match(/(?:check-in|checkin|in)\s*:\s*(.*)/i);
      if (inMatch) {
        checkInStr = inMatch[1].trim();
      }
      
      // Parse Check-out Time
      const outMatch = cleanLine.match(/(?:check-out|checkout|out)\s*:\s*(.*)/i);
      if (outMatch) {
        checkOutStr = outMatch[1].trim();
      }
      
      // Parse Name (if explicit name label exists, e.g. "Name: Arjun")
      const nameMatch = cleanLine.match(/name\s*:\s*(.*)/i);
      if (nameMatch) {
        name = nameMatch[1].trim();
      }
    });
    
    // Now look up matched employee
    const employees = (database.getEmployees() || []).filter(e => e && e.status === 'active');
    const sites = (database.getSites() || []).filter(s => s && s.name);
    
    let matchedEmployee = null;
    let employeeConfidence = 0.0;

    // 1. Try phone-based lookup first (most reliable — sender is known)
    if (rawSender) {
      const cleanSender = rawSender.replace(/\D/g, '');
      if (cleanSender) {
        const phoneMatchedEmployee = employees.find(e => e.phone && e.phone.replace(/\D/g, '') === cleanSender);
        if (phoneMatchedEmployee) {
          matchedEmployee = phoneMatchedEmployee;
          employeeConfidence = 1.0;
          if (!name) name = phoneMatchedEmployee.name;
        }
      }
    }

    // 2. Fallback: name-based text matching
    if (!matchedEmployee && name) {
      const match = smartNameMatch(name, employees);
      if (match) {
        matchedEmployee = match.emp;
        employeeConfidence = match.score;
      }
    }
    
    // Look up site
    let matchedSite = defaultSiteObj || null;
    let siteConfidence = defaultSiteObj ? 1.0 : 0.0;
    
    if (siteName) {
      const matched = sites.find(s => s && s.name && (s.name.toLowerCase().includes(siteName.toLowerCase()) || siteName.toLowerCase().includes(s.name.toLowerCase())));
      if (matched) {
        matchedSite = matched;
        siteConfidence = 1.0;
      }
    }
    
    if (!matchedSite && (!siteName || siteName.trim() === "" || siteName.trim() === "—")) {
      if (matchedEmployee && matchedEmployee.siteId) {
        const defSite = sites.find(s => s && (s.id === matchedEmployee.siteId || s.name === matchedEmployee.siteId));
        if (defSite) {
          matchedSite = defSite;
          siteConfidence = 0.5;
        }
      }
      if (!matchedSite && sites.length === 1 && sites[0]) {
        matchedSite = sites[0];
        siteConfidence = 0.5;
      }
    }
    
    // Parse check-in and check-out timestamps
    let checkInTimestamp = null;
    let checkOutTimestamp = null;
    let actionType = 'in';
    
    if (checkInStr && checkOutStr) {
      try {
        checkInTimestamp = parseTimeStr(checkInStr, dateStr, false);
        checkOutTimestamp = parseTimeStr(checkOutStr, dateStr, true);
        actionType = 'completed';
      } catch (err) {
        console.error("Time range parsing failed in multi-line:", err);
      }
    } else if (checkInStr) {
      try {
        checkInTimestamp = parseTimeStr(checkInStr, dateStr, false);
        actionType = 'in';
      } catch (err) {
        console.error("Check-in parsing failed in multi-line:", err);
      }
    } else if (checkOutStr) {
      try {
        checkOutTimestamp = parseTimeStr(checkOutStr, dateStr, true);
        actionType = 'out';
      } catch (err) {
        console.error("Check-out parsing failed in multi-line:", err);
      }
    }
    
    const isSuccess = !!(matchedEmployee && (matchedSite || (siteName && siteName.trim() !== "" && siteName.trim() !== "—")));
    let reason = "";
    if (!matchedEmployee) reason = "Worker name unrecognized";
    else if (!matchedSite && (!siteName || siteName.trim() === "" || siteName.trim() === "—")) reason = "Work site not specified/recognized";
    
    return {
      isSuccess,
      reason,
      matchedEmployeeId: matchedEmployee ? matchedEmployee.id : null,
      matchedSiteId: matchedSite ? matchedSite.id : null,
      extractedName: name || "—",
      extractedSite: matchedSite ? matchedSite.name : (siteName || "—"),
      extractedAction: actionType,
      checkInTime: checkInTimestamp,
      checkOutTime: checkOutTimestamp,
      confidence: Number(((employeeConfidence + siteConfidence) / 2).toFixed(2))
    };
  }

  // Central Entry Point - Splits by newlines and handles line-by-line supervisor lists
  parse(rawText, senderPhone = "", messageTimestamp = null) {
     // Normalize dot-separated times without minutes (e.g., "9.am" -> "9am")
    let cleanedText = rawText
      .replace(/\b(\d{1,2})\s*\.\s*(am|pm)\b/gi, '$1$2')
      .replace(/\b(\d{1,2})\s*[:.]\s*(\d{2})\s*\.\s*(am|pm)\b/gi, '$1:$2$3');
    // Normalize dot-separated times with minutes but no trailing dot before am/pm (e.g., "3.30 pm" -> "3:30 pm", "3.30-6" -> "3:30-6")
    cleanedText = cleanedText.replace(/\b(\d{1,2})\.(\d{2})\b/g, '$1:$2');

    const todayStr = messageTimestamp
      ? new Date(messageTimestamp).toISOString().split('T')[0]
      : new Date().toISOString().split('T')[0];

    // ============================================================
    // REGIONAL LANGUAGE TRANSLATION
    // Translate common attendance messages from Malayalam, Hindi,
    // Tamil, Kannada, Telugu, Odia etc. to English before parsing.
    // Each entry maps a native phrase (or substring) to its English equivalent.
    // ============================================================
    const regionalPhrases = [
      // --- Malayalam ---
      // Leave declarations
      { pattern: /നാളെ\s*ഞാൻ\s*അവധിയാണ്/i,   replacement: 'I am on leave tomorrow' },
      { pattern: /ഇന്ന്\s*ഞാൻ\s*അവധിയാണ്/i,   replacement: 'I am on leave today' },
      { pattern: /ഞാൻ\s*ഇന്ന്\s*അവധിയാണ്/i,   replacement: 'I am on leave today' },
      { pattern: /ഇന്ന്\s*അവധിയാണ്/i,          replacement: 'I am on leave today' },
      { pattern: /നാളെ\s*അവധിയാണ്/i,           replacement: 'I am on leave tomorrow' },
      { pattern: /അവധി\s*ദിനം/i,               replacement: 'I am on leave today' },
      // Half-day leave
      { pattern: /ഹാഫ്\s*ഡേ\s*ലീവ്/i,          replacement: 'half day leave' },
      { pattern: /അര\s*ദിവസം\s*അവധി/i,         replacement: 'half day leave' },
      // Late arrival
      { pattern: /ഒരു\s*മണിക്കൂർ\s*വൈകും/i,    replacement: '1 hour late' },
      { pattern: /(\d+)\s*മണിക്കൂർ\s*വൈകും/i,  replacement: (_, n) => `${n} hour late` },
      { pattern: /വൈകും/i,                       replacement: 'late' },
      { pattern: /ഒരു\s*മണിക്കൂർ\s*ലേറ്റ്/i,   replacement: '1 hour late' },
      { pattern: /(\d+)\s*മണിക്കൂർ\s*ലേറ്റ്/i, replacement: (_, n) => `${n} hour late` },
      { pattern: /ലേറ്റ്\s*ആകും/i,              replacement: 'late' },
      // Check-in / check-out
      { pattern: /ഞാൻ\s*ഓഫീസിൽ\s*എത്തി/i,    replacement: 'checked in at office' },
      { pattern: /ഓഫീസ്\s*ആയി/i,               replacement: 'checked in at office' },
      // Sick leave
      { pattern: /ജ്വരം|പനി|ഇൻഫ്ലുവൻസ/i,      replacement: 'sick leave fever' },
      { pattern: /ചികിത്സ|ആശുപത്രി/i,           replacement: 'hospital leave' },

      // --- Hindi ---
      { pattern: /कल\s*मैं\s*छुट्टी\s*पर\s*हूँ/i, replacement: 'I am on leave tomorrow' },
      { pattern: /आज\s*मैं\s*छुट्टी\s*पर\s*हूँ/i, replacement: 'I am on leave today' },
      { pattern: /मैं\s*आज\s*छुट्टी\s*पर\s*हूँ/i, replacement: 'I am on leave today' },
      { pattern: /आज\s*छुट्टी\s*है/i,             replacement: 'I am on leave today' },
      { pattern: /कल\s*छुट्टी\s*है/i,             replacement: 'I am on leave tomorrow' },
      { pattern: /मुझे\s*छुट्टी\s*चाहिए/i,        replacement: 'I need leave today' },
      { pattern: /देर\s*से\s*आऊंगा/i,             replacement: 'will be late' },
      { pattern: /(\d+)\s*घंटे?\s*देरी/i,         replacement: (_, n) => `${n} hour late` },
      { pattern: /बुखार|बीमार/i,                  replacement: 'sick leave' },

      // --- Tamil ---
      { pattern: /நாளை\s*நான்\s*விடுமுறையில்/i,   replacement: 'I am on leave tomorrow' },
      { pattern: /இன்று\s*நான்\s*விடுமுறையில்/i,  replacement: 'I am on leave today' },
      { pattern: /நான்\s*இன்று\s*விடுமுறை/i,      replacement: 'I am on leave today' },
      { pattern: /விடுமுறை/i,                       replacement: 'leave' },
      { pattern: /காய்ச்சல்|நோய்வாய்ப்பட்டிருக்கிறேன்/i, replacement: 'sick leave' },

      // --- Kannada ---
      { pattern: /ನಾಳೆ\s*ರಜೆ\s*ಮೇಲೆ\s*ಇದ್ದೇನೆ/i, replacement: 'I am on leave tomorrow' },
      { pattern: /ಇಂದು\s*ರಜೆ\s*ಮೇಲೆ\s*ಇದ್ದೇನೆ/i, replacement: 'I am on leave today' },
      { pattern: /ರಜೆ/i,                            replacement: 'leave' },

      // --- Telugu ---
      { pattern: /రేపు\s*నేను\s*సెలవులో\s*ఉన్నాను/i, replacement: 'I am on leave tomorrow' },
      { pattern: /నేడు\s*నేను\s*సెలవులో\s*ఉన్నాను/i, replacement: 'I am on leave today' },
      { pattern: /సెలవు/i,                             replacement: 'leave' },

      // --- Odia ---
      { pattern: /ଆସନ୍ତା\s*ଛୁଟି/i,  replacement: 'leave tomorrow' },
      { pattern: /ଆଜି\s*ଛୁଟି/i,     replacement: 'leave today' },
    ];

    let translatedText = cleanedText;
    for (const { pattern, replacement } of regionalPhrases) {
      if (pattern.test(translatedText)) {
        if (typeof replacement === 'function') {
          translatedText = translatedText.replace(pattern, replacement);
        } else {
          translatedText = translatedText.replace(pattern, replacement);
        }
      }
    }

    // ── Non-Latin Script Safety Guard ──────────────────────────────────────────
    // If the message still contains significant non-Latin characters AFTER the
    // translation pass, it means it's a regional-language message that our
    // dictionary doesn't fully understand. Instead of blindly mis-parsing it as
    // a check-in, send it to the Exception Board for manual admin review.
    //
    // We detect: Malayalam, Hindi/Devanagari, Tamil, Kannada, Telugu, Bengali,
    //            Gujarati, Odia, Gurmukhi, Arabic, Sinhala scripts etc.
    const nonLatinScriptRegex = /[\u0900-\u097F\u0D00-\u0D7F\u0B80-\u0BFF\u0C00-\u0C7F\u0C80-\u0CFF\u0980-\u09FF\u0A80-\u0AFF\u0B00-\u0B7F\u0A00-\u0A7F\u0600-\u06FF\u0D80-\u0DFF]/g;
    const nonLatinChars = (translatedText.match(nonLatinScriptRegex) || []).length;
    const totalChars = translatedText.replace(/\s/g, '').length;

    if (nonLatinChars > 0 && totalChars > 0 && (nonLatinChars / totalChars) > 0.25) {
      // More than 25% of the message is still unrecognised regional script.
      // Detect which language for a helpful error message.
      let detectedLang = 'Regional language';
      if (/[\u0D00-\u0D7F]/.test(translatedText)) detectedLang = 'Malayalam';
      else if (/[\u0900-\u097F]/.test(translatedText)) detectedLang = 'Hindi/Devanagari';
      else if (/[\u0B80-\u0BFF]/.test(translatedText)) detectedLang = 'Tamil';
      else if (/[\u0C80-\u0CFF]/.test(translatedText)) detectedLang = 'Kannada';
      else if (/[\u0C00-\u0C7F]/.test(translatedText)) detectedLang = 'Telugu';
      else if (/[\u0980-\u09FF]/.test(translatedText)) detectedLang = 'Bengali';

      console.log(`[Parser] Detected unrecognised ${detectedLang} message. Routing to Exception Board: "${rawText.substring(0, 60)}"`);
      return {
        isSuccess: false,
        reason: `${detectedLang} message — could not auto-parse. Please resolve manually.`,
        extractedAction: 'in',
        extractedName: '',
        extractedSite: '—',
        confidence: 0,
        rawSender: senderPhone
      };
    }
    // ──────────────────────────────────────────────────────────────────────────

    // Preprocess stuck time ranges like "9to6", "9 to6", "9to 6"
    let preprocessedText = translatedText.replace(/(\d+(?:\s*(?:am|pm))?)(to)/gi, '$1 to');
    preprocessedText = preprocessedText.replace(/(to)(\d+(?:\s*(?:am|pm))?)/gi, 'to $2');

    const employees = (database.getEmployees() || []).filter(e => e && e.status === 'active');
    const sites = (database.getSites() || []).filter(s => s && s.name);
    const correctedText = preprocessedText.replace(/\b[a-zA-Z]+\b/g, match => spellCorrectWord(match, employees, sites));

    // Split into individual clean lines (preserve blanks for group detection)
    const allRawLines = correctedText.split(/\r?\n/).map(l => l.trim());
    const lines = allRawLines.filter(l => l.length > 0);
    
    if (lines.length === 0) {
      return {
        isSuccess: false,
        reason: "Message content is empty",
        extractedAction: 'in',
        extractedName: "",
        extractedSite: "—",
        confidence: 0,
        rawSender: senderPhone
      };
    }

    // ============================================================
    // STEP 0: Multi-Group Supervisor Report Detection
    // Detects messages with blank-line-separated groups where each
    // group has: [names...] + (timing + site info)
    // Example:
    //   12/6/26
    //   Sumesh
    //   Sreeraj
    //   (9-6 pm cavili choondi) 2 hour travel
    //
    //   Aneesh
    //   Sunil Rana
    //   (9-6 Pm Raju Joseph)
    //
    //   Arun George
    //   (9-6 pm Chamakkala market)
    // ============================================================
    if (lines.length >= 3) {
      // Split into raw groups by blank lines if present, otherwise treat as a single group
      const hasBlankLineSeparation = allRawLines.some(l => l.trim() === '');
      const rawGroups = [];
      if (hasBlankLineSeparation) {
        let currentGroup = [];
        for (const line of allRawLines) {
          if (line.trim() === '') {
            if (currentGroup.length > 0) {
              rawGroups.push(currentGroup);
              currentGroup = [];
            }
          } else {
            currentGroup.push(line.trim());
          }
        }
        if (currentGroup.length > 0) rawGroups.push(currentGroup);
      } else {
        rawGroups.push(lines);
      }

      // Extract global date from first group or first line
      let globalDate = todayStr;
      for (const grp of rawGroups) {
        for (const line of grp) {
          const dm = line.match(/\b(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})\b/);
          if (dm) {
            let d = parseInt(dm[1]), m = parseInt(dm[2]), y = parseInt(dm[3]);
            if (y < 100) y += 2000;
            globalDate = `${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
            break;
          }
          const hasRel = /\b(?:yesterday|today|tomorrow|innale|innu|nale)\b/i.test(line);
          if (hasRel) {
            const rd = extractTargetDates(line, messageTimestamp);
            if (rd.length > 0) { globalDate = rd[0]; break; }
          }
        }
        if (globalDate !== todayStr) break;
      }

      // Helper: classify a line within a group
      const settings2 = database.getSettings();
      const travelRatio2 = settings2.travelTimePaidRatio !== undefined ? Number(settings2.travelTimePaidRatio) : 0.50;
      const allSites2 = database.getSites();
      const allEmployees2 = (database.getEmployees() || []).filter(e => e && e.status === 'active');

      const classifyGroupLine = (line, groupHasTiming) => {
        const lower = line.toLowerCase();
        // Date line
        if (/\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b/.test(line)) return { type: 'date' };
        // Travel time (may be whole line or suffix after paren e.g. "(9-6 site)2hr travel")
        const travelM = line.match(/(\d+(?:\.\d+)?)\s*(?:hour|hours|hr|hrs)?\s*trav[a-z]*/i);
        if (travelM) {
          // If whole line is just travel info, classify as travel
          const stripped = line.replace(travelM[0], '').replace(/[.,:;]+$/, '').trim();
          if (stripped.length === 0) return { type: 'travel', hours: parseFloat(travelM[1]) };
          // Else paren + travel tail — handle as paren_block below
        }
        // Parenthesized block often contains timing AND site: "(9-6 pm Raju Joseph)2hr travel"
        const parenBlock = line.match(/^\((.+?)\)\s*(.*)$/);
        if (parenBlock) {
          const inner = parenBlock[1].trim();
          const tail = parenBlock[2].trim();
          // Extract travel from tail
          const tailTravel = tail.match(/(\d+(?:\.\d+)?)\s*(?:hour|hours|hr|hrs)?\s*trav[a-z]*/i);
          return {
            type: 'paren_block',
            inner,
            tail,
            travelFromTail: tailTravel ? parseFloat(tailTravel[1]) : 0
          };
        }
        // Timing: "9-6pm", "9 to 6", "9:30 to 6:00 pm", "3:30-6 pm"
        const timeRange = line.match(/\b\d{1,2}(?::\d{2})?(?:\s*(?:am|pm))?(?:\s*(?:to|-)\s*\d{1,2}(?::\d{2})?(?:\s*(?:am|pm))?)/i);
        if (timeRange) return { type: 'timing', raw: line };
        // Relative date
        if (/\b(?:yesterday|today|tomorrow|innale|innu|nale)\b/i.test(lower)) return { type: 'date' };
        // Site keywords — strong indicators
        // Site keywords and place names — strong indicators
        const hasSiteKw = /\b(?:house|site|yard|office|station|building|ground|road|street|town|city|room|block|zone|field|shop|store|market|company|project|ksrtc|quarters|cavili|choondi|munnar|ernakulam|kothamangalam|muvattupuzha|chamakkala|wireless|gokulam)\b/i.test(lower);
        const hasPlaceWord = lower.split(/\s+/).some(w => AttendanceParser.INDIAN_PLACE_NAMES.has(w.replace(/[.]+$/, '').trim()));
        if (hasSiteKw || hasPlaceWord) return { type: 'site_hint', raw: line };
        // Name-like (alphabetic, no numbers)
        const isAlpha = /^[a-zA-Z\s.'\-]+$/.test(line);
        if (isAlpha && line.length > 1) {
          // If timing has already been found in this group, subsequent alpha lines are more likely site names
          if (groupHasTiming && AttendanceParser.INDIAN_PLACE_NAMES.has(lower.replace(/[.]+$/, '').trim())) {
            return { type: 'site_hint', raw: line };
          }
          return { type: 'name_candidate', raw: line };
        }
        return { type: 'unknown', raw: line };
      };

      // Process each group
      const multiGroupResults = [];
      let multiGroupValid = false;

      for (const grp of rawGroups) {
        const names = [];
        let groupTiming = null;
        let groupSiteWords = [];
        let groupTravel = 0;
        let groupDate = globalDate;

        for (const line of grp) {
          const cls = classifyGroupLine(line, groupTiming !== null);
          if (cls.type === 'date') {
            const dm = line.match(/\b(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})\b/);
            if (dm) {
              let d = parseInt(dm[1]), m = parseInt(dm[2]), y = parseInt(dm[3]);
              if (y < 100) y += 2000;
              groupDate = `${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
            }
          } else if (cls.type === 'travel') {
            groupTravel = cls.hours;
          } else if (cls.type === 'paren_block') {
            // "(9-6 pm Raju Joseph)2hr travel" — extract timing from inner, rest is site
            const inner = cls.inner;
            const trm = inner.match(/\b(\d{1,2}(?::\d{2})?(?:\s*(?:am|pm))?)\s*(?:to|-)\s*(\d{1,2}(?::\d{2})?(?:\s*(?:am|pm))?)\b/i);
             if (trm) groupTiming = trm[0];
            // Remove timing from inner to get site hint
            const siteHint = inner
              .replace(/\b\d{1,2}(?::\d{2})?(?:\s*(?:am|pm))?\s*(?:to|-)\s*\d{1,2}(?::\d{2})?(?:\s*(?:am|pm))?\s*(?:pm|am)?\b/i, '')
              .trim();
            if (siteHint) groupSiteWords.push(siteHint);
            // Travel can be in the tail: "(9-6 site)2 hour travel"
            if (cls.travelFromTail && cls.travelFromTail > 0) {
              groupTravel = cls.travelFromTail;
            }
          } else if (cls.type === 'timing') {
            groupTiming = line;
          } else if (cls.type === 'site_hint') {
            groupSiteWords.push(line);
          } else if (cls.type === 'name_candidate') {
            const lc = line.toLowerCase().replace(/[.]+$/, '').trim();
            const hasSiteKw = /\b(?:house|site|yard|office|station|building|ground|road|street|town|city|room|block|zone|field|shop|store|market|company|project|ksrtc|quarters)\b/i.test(lc);
            // If timing already found, alpha lines after are likely location names, not person names
            const isAfterTiming = groupTiming !== null;
            if (!hasSiteKw && !isAfterTiming && !AttendanceParser.INDIAN_PLACE_NAMES.has(lc)) {
              names.push(line.replace(/[.]+$/, '').trim());
            } else {
              groupSiteWords.push(line);
            }
          }
        }

        // A valid group needs at least 1 name AND (timing or site info)
        if (names.length > 0 && (groupTiming || groupSiteWords.length > 0)) {
          multiGroupValid = true;
          const paidTravel = Number((groupTravel * travelRatio2).toFixed(2));
          // Build a clean site name from site words, stripping duplicates
          const siteName = [...new Set(groupSiteWords)].join(' ').trim();

          for (const name of names) {
            // Build virtual line: "Name, site, timing"
            const parts = [name];
            if (siteName) parts.push(siteName);
            if (groupTiming) parts.push(groupTiming);
            const virtualLine = parts.join(', ');
            const res = this.parseSingleLine(virtualLine.toLowerCase(), groupDate, null, "", messageTimestamp);
            res.rawSender = senderPhone;
            res.originalLineText = virtualLine;
            res.travelHours = paidTravel;
            multiGroupResults.push(res);
          }
        }
      }

      const validGroupCount = rawGroups.filter(grp => {
        let hasName = false, hasDetail = false;
        for (const line of grp) {
          const cls = classifyGroupLine(line, false);
          if (cls.type === 'name_candidate') hasName = true;
          if (cls.type === 'timing' || cls.type === 'paren_block' || cls.type === 'site_hint' || cls.type === 'travel') hasDetail = true;
        }
        return hasName && hasDetail;
      }).length;

      const isMultiGroup = rawGroups.length >= 2 && validGroupCount >= 2;
      const isSingleGroupList = rawGroups.length === 1 && validGroupCount === 1 && multiGroupResults.length >= 2;

      if (multiGroupValid && (isMultiGroup || isSingleGroupList) && multiGroupResults.length > 0) {
        console.log(`[Parser] Detected Group Supervisor Report: ${rawGroups.length} groups, ${multiGroupResults.length} employees.`);
        return { isList: true, items: multiGroupResults };
      }
    }

    // A. Pre-process to extract travel hours and identify explicit site line (supporting both global and per-line travel)
    let globalPaidTravelHours = 0;
    let explicitSiteLine = null;
    const lineTravelMap = new Map();

    const cleanLines = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // Normalize time ranges that are stuck together (e.g. 9-6pm)
      const processedLine = line.replace(/(\d+)-(\d+)(am|pm)/gi, '$1-$2 $3');
      const travelMatch = processedLine.match(/(\d+(?:\.\d+)?)\s*(?:hour|hours|hr|hrs)?\s*trav[a-z]*/i);
      if (travelMatch) {
        const reported = parseFloat(travelMatch[1]);
        const settings = database.getSettings();
        const ratio = settings.travelTimePaidRatio !== undefined ? Number(settings.travelTimePaidRatio) : 0.50;
        const paid = Number((reported * ratio).toFixed(2));

        const isWholeLine = line.toLowerCase().replace(travelMatch[0].toLowerCase(), '').replace(/[.,:;]+$/, '').trim().length === 0;
        if (isWholeLine) {
          globalPaidTravelHours = paid;
          if (i > 0) {
            const prevLine = lines[i - 1];
            if (!prevLine.match(/\b(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})\b/)) {
              explicitSiteLine = prevLine;
            }
          }
        } else {
          const rest = line.replace(travelMatch[0], '').trim();
          if (rest.length > 0) {
            cleanLines.push(rest);
            lineTravelMap.set(rest.toLowerCase(), paid);
          }
        }
      } else {
        cleanLines.push(line);
      }
    }

    const activeLines = cleanLines;

    const getTravelHoursForLine = (lineText) => {
      const clean = lineText.toLowerCase().trim();
      const lineTravel = lineTravelMap.get(clean) || 0;
      return lineTravel > 0 ? lineTravel : globalPaidTravelHours;
    };

    // 1. Detect Default Site mapping in headers (e.g. "Site: Site A" or first line being site name)
    let defaultSiteObj = null;
    
    // Check first 2 lines for "site:" keyword
    for (let i = 0; i < Math.min(2, activeLines.length); i++) {
      const lineLower = activeLines[i].toLowerCase();
      const siteMatch = lineLower.match(/site\s*:\s*(.*)/i);
      
      if (siteMatch) {
        const searchName = siteMatch[1].trim();
        const matched = sites.find(s => s.name.toLowerCase().includes(searchName) || searchName.includes(s.name.toLowerCase()));
        if (matched) {
          defaultSiteObj = matched;
          break;
        }
      } else {
        // Direct matching if whole line matches a registered site
        const matched = sites.find(s => s.name.toLowerCase() === lineLower);
        if (matched) {
          defaultSiteObj = matched;
          break;
        }
      }

      // Special-case: messages of form:\n"Name\nSite\n10-6" or "Name\nSite\nIn:..." -> treat as single-worker multi-line
      if (activeLines.length >= 2 && activeLines.length <= 4) {
        const timeRegexLine = /\b\d{1,2}(?:[:.]\d{2})?\s*(?:am|pm)?\s*(?:to|-|-)\s*\d{1,2}(?:[:.]\d{2})?\s*(?:am|pm)?\b/i;
        const simpleRange = /\b\d{1,2}\s*-\s*\d{1,2}\b/;
        const hasTimeLine = activeLines.some(l => timeRegexLine.test(l) || simpleRange.test(l));
        const nameLine = activeLines[0] ? activeLines[0].trim() : '';
        const siteLine = activeLines[1] ? activeLines[1].trim() : '';

        const isNameLike = /^[a-zA-Z\s.']+$/.test(nameLine) && nameLine.length > 1;
        const isSiteLike = siteLine.length > 1 && /^[a-zA-Z\s.()-]+$/.test(siteLine);

        if (isNameLike && isSiteLike && hasTimeLine) {
          // Build a virtual single-line and parse
          const virtual = `${nameLine}, ${siteLine}, ${activeLines.find(l => timeRegexLine.test(l) || simpleRange.test(l))}`;
          const targetDates = extractTargetDates(virtual, messageTimestamp);
          if (targetDates.length > 1) {
            const items = targetDates.map(d => {
              const res = this.parseSingleLine(virtual.toLowerCase(), d, defaultSiteObj, senderPhone, messageTimestamp);
              res.rawSender = senderPhone;
              res.originalLineText = virtual;
              res.travelHours = getTravelHoursForLine(virtual);
              return res;
            });
            return {
              isList: true,
              items: items
            };
          } else {
            const res = this.parseSingleLine(virtual.toLowerCase(), targetDates[0], defaultSiteObj, senderPhone, messageTimestamp);
            res.rawSender = senderPhone;
            res.isList = false;
            res.travelHours = getTravelHoursForLine(virtual);
            return res;
          }
        }
      }
    }

    // 2. Detect if this is a single-worker multi-line report
    const hasMultipleLines = activeLines.length > 1;
    const hasInOrOut = activeLines.some(line => {
      const l = line.toLowerCase();
      return l.startsWith('in\s*:') || l.includes('in :') || l.includes('in:') ||
             l.startsWith('out\s*:') || l.includes('out :') || l.includes('out:') ||
             l.startsWith('check-in') || l.includes('check-in:') ||
             l.startsWith('check-out') || l.includes('check-out:') ||
             l.startsWith('checkin') || l.includes('checkout');
    });

    if (hasMultipleLines && hasInOrOut) {
      console.log(`[Parser] Detected single-worker multi-line report.`);
      let singleWorkerDate = todayStr;
      for (const line of activeLines) {
        const hasDateWord = /\b(?:yesterday|today|tomorrow|innale|innu|nale|munninale|minnannu|\d{1,2}\/\d{1,2})\b/i.test(line);
        if (hasDateWord) {
          const dates = extractTargetDates(line, messageTimestamp);
          if (dates.length > 0) {
            singleWorkerDate = dates[0];
            break;
          }
        }
      }
      const res = this.parseSingleWorkerMultiLine(activeLines, singleWorkerDate, defaultSiteObj, senderPhone);
      res.rawSender = senderPhone;
      res.isList = false;
      res.travelHours = getTravelHoursForLine(activeLines.join('\n'));
      return res;
    }

    // 3. Detect if this is a Bulk Shared-Details Report (e.g. list of names, followed by shared date/time/location)
    if (hasMultipleLines && !hasInOrOut) {
      let reportDate = null;
      let reportTimeRange = null;
      let reportSiteLines = [];
      const workerNames = [];

      activeLines.forEach(line => {
        const clean = line.trim();
        const lower = clean.toLowerCase();
        if (clean.length === 0) return;

        // A. Check for date: "25/5/26" or relative date keyword
        const dateMatch = clean.match(/\b(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})\b/);
        if (dateMatch) {
          let day = parseInt(dateMatch[1]);
          let month = parseInt(dateMatch[2]);
          let year = parseInt(dateMatch[3]);
          if (year < 100) year += 2000;
          reportDate = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
          return;
        }

        const hasRelative = /\b(?:yesterday|today|tomorrow|innale|innu|nale|munninale|minnannu)\b/i.test(lower);
        if (hasRelative && !reportDate) {
          const relativeDates = extractTargetDates(clean, messageTimestamp);
          if (relativeDates.length > 0) {
            reportDate = relativeDates[0];
            return;
          }
        }

        // B. Check for time range: "9 to 6", "9-6"
        const isTimeRange = lower.match(/\b\d{1,2}(?::\d{2})?(?:\s*(?:am|pm))?\s*(?:to|-)\s*\d{1,2}(?::\d{2})?(?:\s*(?:am|pm))?\b/i);
        if (isTimeRange) {
          reportTimeRange = clean;
          return;
        }

        // C. Check if it matches a registered site exactly
        const matchedSite = sites.find(s => s && s.name && s.name.toLowerCase() === lower);
        if (matchedSite) {
          reportSiteLines.push(matchedSite.name);
          return;
        }

        // D. Check for names vs unregistered sites
        const isAlphabetic = /^[a-zA-Z\s.()-]+$/.test(clean);
        const hasKeywords = lower.match(/\b(to|am|pm|in|out|site|check|present|absent|leave)\b/);
        
        if (isAlphabetic && !hasKeywords) {
          const isAfterTimeRange = (reportTimeRange !== null);
          const containsSiteKeywords = lower.match(/\b(house|site|yard|office|station|building|ground|road|street|town|city|room|block|zone|field|shop|store|company|project)\b/);
          
          const isExplicitSite = (explicitSiteLine && explicitSiteLine.toLowerCase() === lower);

          if (isAfterTimeRange || containsSiteKeywords || isExplicitSite) {
            reportSiteLines.push(clean.replace(/[.]+$/, '').trim());
          } else {
            // SAFEGUARD: Do not push if it is a known place name, to prevent registering places as workers
            if (!AttendanceParser.INDIAN_PLACE_NAMES.has(lower.replace(/[.]+$/, '').trim())) {
              workerNames.push(clean.replace(/[.]+$/, '').trim());
            } else {
              reportSiteLines.push(clean.replace(/[.]+$/, '').trim());
            }
          }
        }
      });

      // If we successfully classified worker names AND (a shared time range or a shared location was found),
      // then this is indeed a Bulk Shared-Details Report!
      if (workerNames.length > 0 && (reportTimeRange || reportSiteLines.length > 0)) {
        console.log(`[Parser] Detected Bulk Shared-Details Report for ${workerNames.length} workers.`);
        const results = [];
        const targetDate = reportDate || todayStr;
        const finalSiteName = reportSiteLines.join(' ') || "—";
        const finalTimeRange = reportTimeRange || "";

        workerNames.forEach(name => {
          // Reconstruct virtual single-line report
          const virtualLine = `${name}, ${finalSiteName}, ${finalTimeRange}`;
          const res = this.parseSingleLine(virtualLine.toLowerCase(), targetDate, defaultSiteObj, "", messageTimestamp);
          res.rawSender = senderPhone;
          res.originalLineText = virtualLine;
          res.travelHours = getTravelHoursForLine(virtualLine);
          results.push(res);
        });

        return {
          isList: true,
          items: results
        };
      }
    }

    // 2. Parse line-by-line (Multi-worker lists vs. Single worker texts)
    // Filter out header lines containing only site markers, dates, or relative date keywords
    const dataLines = activeLines.filter(line => {
      const lineLower = line.toLowerCase().trim();
      if (lineLower.startsWith("site:") || sites.some(s => s.name.toLowerCase() === lineLower)) {
        return false;
      }
      
      const isExplicitDate = /^\s*\[\d{1,2}\/\d{1,2}(?:[/-]\d{2,4})?\]\s*:?\s*$/.test(lineLower) || 
                             /^\s*\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\s*:?\s*$/.test(lineLower);
      const isRelativeDateOnly = /^\s*(yesterday|today|tomorrow|innale|innu|nale|munninale|minnannu)\b\s*:?\s*$/i.test(lineLower);
      if (isExplicitDate || isRelativeDateOnly) {
        return false;
      }
      
      return true;
    });

    // Let's determine a default date for the list by checking the first 3 lines of activeLines
    let listDefaultDate = todayStr;
    for (let i = 0; i < Math.min(3, activeLines.length); i++) {
      const line = activeLines[i].toLowerCase().trim();
      const dateMatch = line.match(/\b(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})\b/);
      if (dateMatch) {
        let day = parseInt(dateMatch[1]);
        let month = parseInt(dateMatch[2]);
        let year = parseInt(dateMatch[3]);
        if (year < 100) year += 2000;
        listDefaultDate = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        break;
      }
      
      const hasRelative = /\b(?:yesterday|today|tomorrow|innale|innu|nale|munninale|minnannu)\b/i.test(line);
      if (hasRelative) {
        const parsedRelDates = extractTargetDates(line, messageTimestamp);
        if (parsedRelDates.length > 0) {
          listDefaultDate = parsedRelDates[0];
          break;
        }
      }
    }

    // Count how many lines contain a recognized employee name
    let matchingEmployeeLinesCount = 0;
    dataLines.forEach(line => {
      const lineLower = line.toLowerCase();
      const hasEmp = employees.some(e => {
        if (!e || !e.name) return false;
        const nameParts = e.name.toLowerCase().split(/\s+/);
        const firstName = nameParts[0];
        const rx = new RegExp('\\b' + firstName + '\\b', 'i');
        return firstName.length > 2 && rx.test(lineLower);
      });
      if (hasEmp) matchingEmployeeLinesCount++;
    });

    if (dataLines.length > 1 && matchingEmployeeLinesCount > 1) {
      // Option 2: Consolidated Supervisor Report List!
      console.log(`[Parser] Detected supervisor list with ${dataLines.length} worker lines.`);
      const results = [];
      
      dataLines.forEach(line => {
        const cleanLine = line.toLowerCase();
        // Check if individual line specifies its own date
        const lineDates = extractTargetDates(cleanLine, messageTimestamp);
        const hasRelativeOrExplicit = /\b(?:yesterday|today|tomorrow|innale|innu|nale|munninale|minnannu|\d{1,2}\/\d{1,2})\b/i.test(cleanLine);
        const targetDate = hasRelativeOrExplicit && lineDates.length > 0 ? lineDates[0] : listDefaultDate;

        const res = this.parseSingleLine(cleanLine, targetDate, defaultSiteObj, "", messageTimestamp);
        res.rawSender = senderPhone;
        res.originalLineText = line;
        res.travelHours = getTravelHoursForLine(cleanLine);
        results.push(res);
      });
      
      return {
        isList: true,
        items: results
      };
    } else {
      // Option 1 or standard single check-in text
      const cleanLine = activeLines.join(' ');
      const targetDates = extractTargetDates(cleanLine, messageTimestamp);
      if (targetDates.length > 1) {
        console.log(`[Parser] Semantic parser identified multi-day entry for dates: ${targetDates.join(', ')}`);
        const items = targetDates.map(d => {
          const res = this.parseSingleLine(cleanLine, d, defaultSiteObj, senderPhone, messageTimestamp);
          res.rawSender = senderPhone;
          res.originalLineText = cleanLine;
          res.travelHours = getTravelHoursForLine(cleanLine);
          return res;
        });
        return {
          isList: true,
          items: items
        };
      } else {
        const res = this.parseSingleLine(cleanLine, targetDates[0], defaultSiteObj, senderPhone, messageTimestamp);
        res.rawSender = senderPhone;
        res.isList = false;
        res.travelHours = getTravelHoursForLine(cleanLine);
        return res;
      }
    }
  }
}

module.exports = new AttendanceParser();
