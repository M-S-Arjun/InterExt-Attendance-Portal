const http = require('http');
const fs = require('fs');

// Read the database to get the password
const dbContent = JSON.parse(fs.readFileSync('data.json', 'utf8'));
const adminPassword = dbContent.settings?.adminPassword || 'admin123';

function makeRequest(path, method, bodyObj, headers = {}) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify(bodyObj);
    const options = {
      hostname: 'localhost',
      port: 3000,
      path: path,
      method: method,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData),
        ...headers
      }
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: data
        });
      });
    });

    req.on('error', (err) => { reject(err); });
    req.write(postData);
    req.end();
  });
}

async function run() {
  try {
    console.log("1. Logging in...");
    // Since expectedPassword might be a hash or plain, we pass the plain password
    // If the database has a hash, we try 'admin123' first, or if we know the plain text password we can use it.
    // The default in settings is admin123.
    const loginRes = await makeRequest('/api/admin/login', 'POST', { password: 'admin123' });
    console.log(`Login Status: ${loginRes.statusCode}`);
    console.log(`Login Headers: ${JSON.stringify(loginRes.headers)}`);
    console.log(`Login Body: ${loginRes.body}`);

    let cookie = '';
    if (loginRes.headers['set-cookie']) {
      cookie = loginRes.headers['set-cookie'][0].split(';')[0];
      console.log(`Retrieved Cookie: ${cookie}`);
    } else {
      console.log("No cookie returned, check password.");
      return;
    }

    console.log("\n2. Making AI Query request...");
    const queryRes = await makeRequest('/api/ai/query', 'POST', { query: 'give me excel of present employees today' }, { 'Cookie': cookie });
    console.log(`Query Status: ${queryRes.statusCode}`);
    console.log(`Query Body: ${queryRes.body}`);
  } catch (err) {
    console.error("Test failed:", err);
  }
}

run();
