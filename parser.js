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

class AttendanceParser {
  // Known Indian place names - to prevent confusion with employee names
  static INDIAN_PLACE_NAMES = new Set([
    'kochi', 'kottayam', 'thodupuzha', 'muvattupuzha', 'vazhakulam', 'vengalloor', 
    'kothamangalam', 'thrissur', 'ernakulam', 'idukki', 'wayanad', 'malappuram',
    'kannur', 'kasaragod', 'kollam', 'pathanamthitta', 'alappuzha', 'thiruvananthapuram',
    'palakkad', 'thiruvananthapuram', 'cochin', 'trivandrum', 'coimbatore', 'bangalore',
    'mangalore', 'calicut', 'kozhikode', 'mattancherry', 'fort kochi', 'munnar',
    'vagamon', 'thekkady', 'varkala', 'alleppey', 'kumarakom', 'backwaters', 'kerala'
  ]);

  // Parse a single text line/message
  parseSingleLine(cleanLine, dateStr = null, defaultSiteObj = null, rawSender = "", messageTimestamp = null) {
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
    const validEmployees = employees.filter(e => 
      e && e.name && !AttendanceParser.INDIAN_PLACE_NAMES.has(e.name.toLowerCase())
    );

    // Clean nameLine to isolate the worker name
    let nameLineClean = cleanLine.toLowerCase();
    // Strip time ranges (e.g. 9-6, 9 to 6)
    nameLineClean = nameLineClean.replace(/\b\d{1,2}(?:\s*(?:am|pm))?\s*(?:to|-)\s*\d{1,2}(?:\s*(?:am|pm))?\b/gi, '');
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
    nameLineClean = nameLineClean.replace(/[,;\-|:()]/g, ' ').replace(/\s+/g, ' ').trim();

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
          if (!matchedEmployee || employeeConfidence < 0.95) {
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

    // Extract site from delimiters fallback if matchedSite is still null
    let hasFallbackLocation = false;
    if (!matchedSite && parts.length > 1) {
      const locationPart = parts.slice(1).find(part => {
        if (!part) return false;
        const p = part.toLowerCase().trim();
        if (p === '—' || p === '' || p === '-') return false;
        
        // If the part is ONLY digits/time-range/parentheses/punctuation, reject it
        const hasTimeOnly = p.match(/^\s*[()\d\s\-:apmto—]+\s*$/i);
        if (hasTimeOnly) return false;

        return !p.match(/\b(in|out|check|site|name)\b/);
      });
      if (locationPart) {
        // Clean any time ranges, digits, or parentheses from the extracted site
        let cleanedLocation = locationPart
          .replace(/\b\d{1,2}(?:\s*(?:am|pm))?\s*(?:to|-)\s*\d{1,2}(?:\s*(?:am|pm))?\b/i, '')
          .replace(/[()]/g, '')
          .trim();

        if (cleanedLocation.length > 0) {
          extractedSite = cleanedLocation.split(/\s+/).map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
          hasFallbackLocation = true;
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
    const leaveKeywords = [
      'on leave', 'leave today', 'leave tomorrow', 'taking leave', 'casual leave', 'sick leave', 'cl', 'sl', 'el', 'pl',
      'not coming', 'not coming today', 'not available', 'absent today', 'taking off', 'day off', 'off today',
      'not able to come', 'not able to attend', 'not reaching today', 'hospital case leave'
    ];
    const isLeave = leaveKeywords.some(kw => cleanLine.includes(kw))
      || /\b(?:i\s+am\s+)?(?:on\s+)?leave\b/i.test(cleanLine);

    let checkInTimestamp = null;
    let checkOutTimestamp = null;
    let actionType = 'in';

    if (isLeave) {
      actionType = 'leave';
    } else {
      // Check for Late pattern
      const lateMatch1 = cleanLine.match(/\b(\d+(?:\.\d+)?|one|two|three|four)\s*(?:hour|hours|hr|hrs)?\s*late\b/i);
      const lateMatch2 = cleanLine.match(/\blate\s*(?:by\s*)?(\d+(?:\.\d+)?|one|two|three|four)\s*(?:hour|hours|hr|hrs)?\b/i);
      
      const wordToNumber = { 'one': 1, 'two': 2, 'three': 3, 'four': 4 };
      let matchedLate = lateMatch1 || lateMatch2;
      let hasParsedLate = false;

      if (matchedLate) {
        const valStr = matchedLate[1].toLowerCase();
        const lateHours = wordToNumber[valStr] !== undefined ? wordToNumber[valStr] : parseFloat(valStr);
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
        }
      }

      // Perform time matching on cleanLine without the late phrase to prevent matching duration numbers
      const lineForTimeMatching = matchedLate ? cleanLine.replace(matchedLate[0], '') : cleanLine;
      const timeRegex = /\b(\d{1,2}(?:[:.]\d{2})?\s*(?:am|pm)?)\b/gi;
      const timeMatches = lineForTimeMatching.match(timeRegex) || [];

      if (timeMatches.length >= 2) {
        try {
          checkInTimestamp = parseTimeStr(timeMatches[0], dateStr, false);
          checkOutTimestamp = parseTimeStr(timeMatches[1], dateStr, true);
          actionType = 'completed';
        } catch (err) {
          console.error("Time range parsing failed:", err);
        }
      } else if (timeMatches.length === 1) {
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
    if (actionType === 'leave') {
      const isTomorrow = /\btomorrow\b/i.test(cleanLine);
      if (isTomorrow && dateStr) {
        try {
          const parts = dateStr.split('-');
          const dateObj = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
          dateObj.setDate(dateObj.getDate() + 1);
          
          const y = dateObj.getFullYear();
          const m = String(dateObj.getMonth() + 1).padStart(2, '0');
          const d = String(dateObj.getDate()).padStart(2, '0');
          leaveDate = `${y}-${m}-${d}`;
        } catch (e) {
          leaveDate = dateStr;
        }
      } else {
        leaveDate = dateStr;
      }
    }

    const isSuccess = !!(matchedEmployee && (actionType === 'leave' || matchedSite || (extractedSite && extractedSite !== "—")));
    let reason = "";
    if (!matchedEmployee) reason = "Worker name unrecognized";
    else if (actionType !== 'leave' && !matchedSite && (!extractedSite || extractedSite === "—")) reason = "Work site not specified/recognized";

    return {
      isSuccess,
      reason,
      matchedEmployeeId: matchedEmployee ? matchedEmployee.id : null,
      matchedSiteId: matchedSite ? matchedSite.id : null,
      extractedName: extractedName || parts[0] || cleanLine.substring(0, 15),
      extractedSite: actionType === 'leave' && (!extractedSite || extractedSite === "—") ? "—" : (extractedSite || "—"),
      extractedAction: actionType,
      checkInTime: checkInTimestamp,
      checkOutTime: checkOutTimestamp,
      leaveDate: leaveDate,
      confidence: Number(((employeeConfidence + siteConfidence) / 2).toFixed(2))
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
    const todayStr = messageTimestamp
      ? new Date(messageTimestamp).toISOString().split('T')[0]
      : new Date().toISOString().split('T')[0];
    
    // Split into individual clean lines
    const lines = rawText.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);
    
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

    // A. Pre-process to extract travel hours and identify explicit site line
    let reportedTravelHours = 0;
    let paidTravelHours = 0;
    let explicitSiteLine = null;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const travelMatch = line.match(/(\d+(?:\.\d+)?)\s*(?:hour|hours|hr|hrs)?\s*(?:traveling|travel|travel\s*time)/i);
      if (travelMatch) {
        reportedTravelHours = parseFloat(travelMatch[1]);
        const settings = database.getSettings();
        const ratio = settings.travelTimePaidRatio !== undefined ? Number(settings.travelTimePaidRatio) : 0.50;
        paidTravelHours = Number((reportedTravelHours * ratio).toFixed(2));

        const isWholeLine = line.toLowerCase().replace(travelMatch[0].toLowerCase(), '').trim().length === 0;
        if (isWholeLine && i > 0) {
          // The line immediately before the travel line is the site name!
          const prevLine = lines[i - 1];
          // Ensure it's not a date line
          if (!prevLine.match(/\b(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})\b/)) {
            explicitSiteLine = prevLine;
          }
        }
        break;
      }
    }

    // B. Clean travel time from lines
    const cleanLines = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const travelMatch = line.match(/(\d+(?:\.\d+)?)\s*(?:hour|hours|hr|hrs)?\s*(?:traveling|travel|travel\s*time)/i);
      if (travelMatch) {
        const isWholeLine = line.toLowerCase().replace(travelMatch[0].toLowerCase(), '').trim().length === 0;
        if (!isWholeLine) {
          const rest = line.replace(travelMatch[0], '').trim();
          if (rest.length > 0) {
            cleanLines.push(rest);
          }
        }
        // Skip whole line travel indicators
      } else {
        cleanLines.push(line);
      }
    }

    // Use cleanLines for the rest of parsing
    const activeLines = cleanLines;

    // 1. Detect Default Site mapping in headers (e.g. "Site: Site A" or first line being site name)
    const sites = database.getSites();
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
          const res = this.parseSingleLine(virtual.toLowerCase(), todayStr, defaultSiteObj, senderPhone, messageTimestamp);
          res.rawSender = senderPhone;
          res.isList = false;
          res.travelHours = paidTravelHours;
          return res;
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
      const res = this.parseSingleWorkerMultiLine(activeLines, todayStr, defaultSiteObj, senderPhone);
      res.rawSender = senderPhone;
      res.isList = false;
      res.travelHours = paidTravelHours;
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

        // A. Check for date: "25/5/26"
        const dateMatch = clean.match(/\b(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})\b/);
        if (dateMatch) {
          let day = parseInt(dateMatch[1]);
          let month = parseInt(dateMatch[2]);
          let year = parseInt(dateMatch[3]);
          if (year < 100) year += 2000;
          reportDate = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
          return;
        }

        // B. Check for time range: "9 to 6", "9-6"
        const isTimeRange = lower.match(/\b\d{1,2}(?:\s*(?:am|pm))?\s*(?:to|-)\s*\d{1,2}(?:\s*(?:am|pm))?\b/i);
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
          res.travelHours = paidTravelHours;
          results.push(res);
        });

        return {
          isList: true,
          items: results
        };
      }
    }

    // 2. Parse line-by-line (Multi-worker lists vs. Single worker texts)
    // Filter out header lines containing only site markers
    const dataLines = activeLines.filter(line => {
      const lineLower = line.toLowerCase();
      return !lineLower.startsWith("site:") && !sites.some(s => s.name.toLowerCase() === lineLower);
    });

    if (dataLines.length > 1) {
      // Option 2: Consolidated Supervisor Report List!
      console.log(`[Parser] Detected supervisor list with ${dataLines.length} worker lines.`);
      const results = [];
      
      dataLines.forEach(line => {
        const cleanLine = line.toLowerCase();
        const res = this.parseSingleLine(cleanLine, todayStr, defaultSiteObj, "", messageTimestamp);
        res.rawSender = senderPhone;
        res.originalLineText = line;
        res.travelHours = paidTravelHours;
        results.push(res);
      });
      
      return {
        isList: true,
        items: results
      };
    } else {
      // Option 1 or standard single check-in text
      const cleanLine = dataLines[0] ? dataLines[0].toLowerCase() : activeLines[0].toLowerCase();
      const res = this.parseSingleLine(cleanLine, todayStr, defaultSiteObj, senderPhone, messageTimestamp);
      res.rawSender = senderPhone;
      res.isList = false;
      res.travelHours = paidTravelHours;
      return res;
    }
  }
}

module.exports = new AttendanceParser();
