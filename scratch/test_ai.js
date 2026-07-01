const http = require('http');

const data = JSON.stringify({ query: 'how many staff members are present today?' });

const options = {
  hostname: 'localhost',
  port: 3000,
  path: '/api/ai/query',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Content-Length': data.length,
    'Cookie': 'admin_token=invalid_session_token_123'
  }
};

const req = http.request(options, (res) => {
  console.log(`STATUS: ${res.statusCode}`);
  console.log(`HEADERS: ${JSON.stringify(res.headers)}`);
  res.setEncoding('utf8');
  let body = '';
  res.on('data', (chunk) => {
    body += chunk;
  });
  res.on('end', () => {
    console.log(`BODY: ${body.substring(0, 500)}`);
  });
});

req.on('error', (e) => {
  console.error(`problem with request: ${e.message}`);
});

req.write(data);
req.end();
