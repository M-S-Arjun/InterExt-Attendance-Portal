# Use the official Node.js 20 lightweight Alpine Linux image
FROM node:20-alpine

# Install Chromium and dependencies needed for headless browser automation
RUN apk add --no-cache \
      chromium \
      nss \
      freetype \
      harfbuzz \
      ca-certificates \
      ttf-freefont

# Tell Puppeteer to skip downloading Chrome and use the installed Chromium binary
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser

# Set working directory inside the container
WORKDIR /app

# Copy package.json and package-lock.json
COPY package*.json ./

# Install production dependencies only
RUN npm install --omit=dev

# Copy the rest of the application files
COPY . .

# Expose the port Express runs on
EXPOSE 3000

# Start the Node.js application
CMD ["node", "server.js"]
