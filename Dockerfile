FROM node:18-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy the rest of the application
COPY . .

# Build the React app
RUN npm run install-client
RUN npm run build

# Expose the port
EXPOSE 5000

# Start the application
CMD ["npm", "start"] 