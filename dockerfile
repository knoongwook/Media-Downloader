     # Use official Node.js 18 image
     FROM node:18

     # Install ffmpeg and Python for yt-dlp/Widevine
     RUN apt-get update && apt-get install -y ffmpeg python3 python3-pip

     # Install yt-dlp via pip for DRM support
     RUN pip3 install yt-dlp

     # Set working directory
     WORKDIR /app

     # Copy package.json and install Node.js dependencies
     COPY package.json .
     RUN npm install

     # Copy application code
     COPY server.js .

     # Create uploads directory for cookies
     RUN mkdir -p uploads

     # Expose port
     EXPOSE 3000

     # Start the application
     CMD ["npm", "start"]