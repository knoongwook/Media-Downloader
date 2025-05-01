     const express = require('express');
     const ytdl = require('ytdl-core');
     const ytdlp = require('yt-dlp-exec');
     const ffmpeg = require('fluent-ffmpeg');
     const NodeCache = require('node-cache');
     const cors = require('cors');
     const { createWriteStream, unlink, writeFileSync } = require('fs');
     const { promisify } = require('util');
     const path = require('path');
     const multer = require('multer');

     const app = express();
     const cache = new NodeCache({ stdTTL: 3600 }); // Cache for 1 hour

     app.use(cors());
     app.use(express.json());

     // Configure multer for file uploads
     const upload = multer({ dest: 'uploads/' });

     const unlinkAsync = promisify(unlink);

     // Map quality to yt-dlp formats
     const qualityMap = {
         low: { video: 'worst', audio: 'bestaudio[abr<=64]' },
         medium: { video: 'best[height<=720]', audio: 'bestaudio[abr<=128]' },
         high: { video: 'best[height<=1080]', audio: 'bestaudio[abr<=320]' },
         '4k': { video: 'best[height<=2160]', audio: 'bestaudio' },
         '8k': { video: 'best[height<=4320]', audio: 'bestaudio' },
         '16k': { video: 'best', audio: 'bestaudio' } // Placeholder
     };

     // Fetch media info
     app.post('/info', upload.single('cookies'), async (req, res) => {
         const { urls, platform } = req.body ? JSON.parse(req.body.urls ? req.body.urls : '[]') : [];
         const cookiesPath = req.file ? req.file.path : null;

         if (!urls || !Array.isArray(urls)) {
             if (cookiesPath) await unlinkAsync(cookiesPath);
             return res.status(400).send('Invalid URLs');
         }

         try {
             const mediaInfo = await Promise.all(urls.map(async url => {
                 const cacheKey = `info:${url}:${platform || 'auto'}`;
                 const cached = cache.get(cacheKey);
                 if (cached) return cached;

                 let info;
                 const ytdlpOptions = { 
                     dumpSingleJson: true,
                     noCheckCertificates: true,
                     userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
                 };
                 if (cookiesPath) ytdlpOptions.cookies = cookiesPath;

                 // Optimize for YouTube Videos/Shorts
                 if (platform === 'youtube' || (platform === 'auto' && (ytdl.validateURL(url) || url.includes('youtube.com/shorts/')))) {
                     const ytInfo = await ytdl.getInfo(url, cookiesPath ? { requestOptions: { headers: { cookie: require('fs').readFileSync(cookiesPath, 'utf8') } } } : {});
                     info = {
                         url,
                         title: ytInfo.videoDetails.title,
                         thumbnail: ytInfo.videoDetails.thumbnails[0].url,
                         duration: new Date(ytInfo.videoDetails.lengthSeconds * 1000).toISOString().substr(11, 8),
                         type: url.includes('youtube.com/shorts/') ? 'YouTube Shorts' : 'YouTube Video'
                     };
                 } 
                 // Optimize for Facebook Videos/Reels
                 else if (platform === 'facebook' || (platform === 'auto' && (url.includes('facebook.com/watch') || url.includes('facebook.com/reel')))) {
                     const fbInfo = await ytdlp(url, ytdlpOptions);
                     info = {
                         url,
                         title: fbInfo.title || 'Facebook Media',
                         thumbnail: fbInfo.thumbnail || 'https://via.placeholder.com/150',
                         duration: fbInfo.duration ? new Date(fbInfo.duration * 1000).toISOString().substr(11, 8) : 'Unknown',
                         type: url.includes('facebook.com/reel') ? 'Facebook Reel' : 'Facebook Video'
                     };
                 } 
                 // Optimize for Instagram Videos/Reels
                 else if (platform === 'instagram' || (platform === 'auto' && (url.includes('instagram.com/p/') || url.includes('instagram.com/reel/')))) {
                     const igInfo = await ytdlp(url, ytdlpOptions);
                     info = {
                         url,
                         title: igInfo.title || 'Instagram Media',
                         thumbnail: igInfo.thumbnail || 'https://via.placeholder.com/150',
                         duration: igInfo.duration ? new Date(igInfo.duration * 1000).toISOString().substr(11, 8) : 'Unknown',
                         type: url.includes('instagram.com/reel/') ? 'Instagram Reel' : 'Instagram Video'
                     };
                 } 
                 // Other platforms
                 else {
                     const ytdlpInfo = await ytdlp(url, ytdlpOptions);
                     info = {
                         url,
                         title: ytdlpInfo.title || 'Untitled Media',
                         thumbnail: ytdlpInfo.thumbnail || 'https://via.placeholder.com/150',
                         duration: ytdlpInfo.duration ? new Date(ytdlpInfo.duration * 1000).toISOString().substr(11, 8) : 'Unknown',
                         type: platform || 'Generic Media'
                     };
                 }

                 cache.set(cacheKey, info);
                 return info;
             }));

             if (cookiesPath) await unlinkAsync(cookiesPath);
             res.json(mediaInfo);
         } catch (error) {
             if (cookiesPath) await unlinkAsync(cookiesPath);
             res.status(500).send(`Failed to fetch info: ${error.message}`);
         }
     });

     // Download media
     app.post('/download', upload.single('cookies'), async (req, res) => {
         const { url, format, quality, trim, startTime, endTime } = req.body;
         const cookiesPath = req.file ? req.file.path : null;

         if (!url || !format || !quality) {
             if (cookiesPath) await unlinkAsync(cookiesPath);
             return res.status(400).send('Missing required fields');
         }

         try {
             const isYouTube = ytdl.validateURL(url) || url.includes('youtube.com/shorts/');
             const cacheKey = `download:${url}:${format}:${quality}:${trim}:${startTime}:${endTime}`;
             const cachedFile = cache.get(cacheKey);

             if (cachedFile) {
                 if (cookiesPath) await unlinkAsync(cookiesPath);
                 res.setHeader('Content-Disposition', `attachment; filename="${cachedFile.name}"`);
                 res.sendFile(cachedFile.path, { root: '.' }, async (err) => {
                     if (!err) await unlinkAsync(cachedFile.path);
                 });
                 return;
             }

             const fileName = `media-${Date.now()}.${format}`;
             const tempPath = path.join(__dirname, fileName);

             if (isYouTube && ['mp3', 'mp4'].includes(format)) {
                 const stream = ytdl(url, {
                     filter: format === 'mp3' ? 'audioonly' : 'videoandaudio',
                     quality: qualityMap[quality].video || qualityMap[quality].audio,
                     requestOptions: cookiesPath ? { headers: { cookie: require('fs').readFileSync(cookiesPath, 'utf8') } } : {}
                 });

                 if (trim && startTime && endTime) {
                     ffmpeg(stream)
                         .setStartTime(startTime)
                         .setDuration(new Date((new Date(`1970-01-01T${endTime}Z`) - new Date(`1970-01-01T${startTime}Z`)) / 1000).toISOString().substr(11, 8))
                         .output(tempPath)
                         .on('end', () => {
                             cache.set(cacheKey, { name: fileName, path: tempPath });
                             res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
                             res.sendFile(tempPath, { root: '.' }, async (err) => {
                                 if (!err) await unlinkAsync(tempPath);
                             });
                         })
                         .on('error', (err) => {
                             if (cookiesPath) unlinkAsync(cookiesPath);
                             res.status(500).send(`Processing error: ${err.message}`);
                         })
                         .run();
                 } else {
                     res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
                     stream.pipe(res);
                 }
             } else {
                 const ytdlpOptions = {
                     output: tempPath,
                     format: format === 'mp3' ? qualityMap[quality].audio : qualityMap[quality].video,
                     noCheckCertificates: true,
                     userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
                 };
                 if (cookiesPath) ytdlpOptions.cookies = cookiesPath;
                 if (trim && startTime && endTime) {
                     ytdlpOptions.postprocessorArgs = [`-ss ${startTime}`, `-to ${endTime}`];
                 }

                 await ytdlp(url, ytdlpOptions);
                 cache.set(cacheKey, { name: fileName, path: tempPath });
                 res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
                 res.sendFile(tempPath, { root: '.' }, async (err) => {
                     if (!err) await unlinkAsync(tempPath);
                     if (cookiesPath) await unlinkAsync(cookiesPath);
                 });
             }
         } catch (error) {
             if (cookiesPath) await unlinkAsync(cookiesPath);
             res.status(500).send(`Download error: ${error.message}`);
         }
     });

     app.listen(process.env.PORT || 3000, () => console.log('Server running'));
     