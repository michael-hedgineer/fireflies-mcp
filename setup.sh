#!/bin/bash

# Exit on error
set -e

echo "Setting up Fireflies MCP Server..."

# Install dependencies
echo "Installing dependencies..."
npm install

# Build the project
echo "Building the project..."
npm run build

echo "Setup complete! You can now run the server with:"
echo "FIREFLIES_API_KEY=your_api_key npm start" 