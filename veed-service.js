import puppeteer from 'puppeteer';
import fs from 'fs';
import path from 'path';
import https from 'https';
import http from 'http';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Path to cookie file (in parent mock directory)
const COOKIE_FILE = path.resolve(__dirname, '../../veed_cookie.txt');

// Veed.io AI Playground URL for image-to-video
const VEED_IMAGE_TO_VIDEO_URL = 'https://www.veed.io/ai-playground?mode=image-to-video&locale=en';

// Parse Netscape cookie file format
function parseNetscapeCookies(cookieContent) {
  const cookies = [];
  const lines = cookieContent.split('\n');

  for (const line of lines) {
    // Skip comments and empty lines
    if (line.startsWith('#') || line.trim() === '') continue;

    const parts = line.split('\t');
    if (parts.length >= 7) {
      const [domain, , path, secure, expiry, name, value] = parts;

      cookies.push({
        name: name,
        value: value,
        domain: domain.startsWith('.') ? domain : '.' + domain,
        path: path,
        secure: secure === 'TRUE',
        httpOnly: false,
        expires: parseInt(expiry) || undefined,
      });
    }
  }

  return cookies;
}

// Load cookies from file
function loadCookies() {
  if (!fs.existsSync(COOKIE_FILE)) {
    throw new Error(`Cookie file not found: ${COOKIE_FILE}`);
  }

  const content = fs.readFileSync(COOKIE_FILE, 'utf-8');
  return parseNetscapeCookies(content);
}

class VeedService {
  constructor() {
    this.browser = null;
    this.page = null;
    this.isAuthenticated = false;
  }

  async initialize() {
    console.log('Initializing Veed.io service...');

    // Launch browser
    this.browser = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
      ]
    });

    this.page = await this.browser.newPage();

    // Set viewport
    await this.page.setViewport({ width: 1920, height: 1080 });

    // Set user agent
    await this.page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );

    // Load and set cookies
    const cookies = loadCookies();
    console.log(`Loaded ${cookies.length} cookies`);

    await this.page.setCookie(...cookies);

    // Verify authentication
    await this.verifyAuth();

    return this.isAuthenticated;
  }

  async verifyAuth() {
    console.log('Verifying Veed.io authentication...');

    try {
      // Try a quick check - navigate to Veed.io dashboard
      await this.page.goto('https://www.veed.io/workspaces', {
        waitUntil: 'domcontentloaded', // Use faster wait condition
        timeout: 20000,
      });

      // Wait a bit for any redirects
      await new Promise(r => setTimeout(r, 2000));

      // Check if we're logged in by looking for workspace elements or redirect to login
      const url = this.page.url();
      console.log('Current URL:', url);

      if (url.includes('/login') || url.includes('/signin')) {
        console.log('Authentication failed - redirected to login');
        this.isAuthenticated = false;
        return false;
      }

      // Check for workspace content
      const workspaceExists = await this.page.$('[data-testid="workspace"]') !== null ||
                              await this.page.$('.workspace') !== null ||
                              url.includes('/workspaces');

      if (workspaceExists || url.includes('veed.io/workspaces')) {
        console.log('Authentication successful!');
        this.isAuthenticated = true;

        // Get user info if available
        const userInfo = await this.page.evaluate(() => {
          // Try to extract user info from page
          const userMeta = document.cookie.split(';')
            .find(c => c.trim().startsWith('user_meta='));
          return userMeta || 'User authenticated';
        });
        console.log('User info:', userInfo.slice(0, 100) + '...');

        return true;
      }

      this.isAuthenticated = false;
      return false;

    } catch (error) {
      console.error('Auth verification error:', error.message);
      // If we have cookies loaded, assume we're authenticated and try anyway
      console.log('Assuming authenticated based on cookies - will verify during video generation');
      this.isAuthenticated = true;
      return true;
    }
  }

  async getAuthStatus() {
    return {
      authenticated: this.isAuthenticated,
      browserConnected: this.browser?.isConnected() || false,
    };
  }

  async takeScreenshot(filename = 'veed-screenshot.png') {
    if (!this.page) throw new Error('Service not initialized');

    const screenshotPath = path.join(__dirname, filename);
    await this.page.screenshot({ path: screenshotPath, fullPage: true });
    console.log(`Screenshot saved: ${screenshotPath}`);
    return screenshotPath;
  }

  // Download video by clicking the Download button
  async downloadVideoWithButton() {
    console.log('Downloading video via Download button...');

    // Create videos directory if it doesn't exist
    const videosDir = path.join(__dirname, '../public/videos');
    if (!fs.existsSync(videosDir)) {
      fs.mkdirSync(videosDir, { recursive: true });
    }

    console.log('Videos directory:', videosDir);

    // Get the video URL first (we'll need this for fallback download)
    const videoUrl = await this.page.evaluate(() => {
      const videos = document.querySelectorAll('video');
      for (const video of videos) {
        if (video.src && video.src.includes('.mp4')) {
          return video.src;
        }
      }
      return null;
    });
    console.log('Video URL:', videoUrl);

    // Set up CDP to configure download behavior and listen for download events
    const client = await this.page.createCDPSession();

    // Track download state
    let downloadStarted = false;
    let downloadComplete = false;
    let downloadedFilename = null;
    let downloadGuid = null;

    // Listen for download events
    client.on('Browser.downloadWillBegin', (event) => {
      console.log('CDP: Download will begin:', event.suggestedFilename, 'GUID:', event.guid);
      downloadStarted = true;
      downloadedFilename = event.suggestedFilename;
      downloadGuid = event.guid;
    });

    client.on('Browser.downloadProgress', (event) => {
      if (event.state === 'completed') {
        console.log('CDP: Download completed!');
        downloadComplete = true;
      } else if (event.state === 'canceled') {
        console.log('CDP: Download canceled!');
      }
    });

    await client.send('Browser.setDownloadBehavior', {
      behavior: 'allowAndName',
      downloadPath: videosDir,
      eventsEnabled: true,
    });

    // Get list of files before download
    const filesBefore = new Set(fs.readdirSync(videosDir));
    console.log('Files before download:', [...filesBefore]);

    // First dismiss any modal dialogs (like "Aspect ratio not matched")
    console.log('Checking for modal dialogs...');
    const modalButton = await this.page.evaluate(() => {
      const buttons = document.querySelectorAll('button');
      for (const btn of buttons) {
        if (btn.textContent.includes('Got it')) {
          btn.click();
          return true;
        }
      }
      return false;
    });
    if (modalButton) {
      console.log('Dismissed modal via evaluate');
      await new Promise(r => setTimeout(r, 1000));
    }

    // Find Download button coordinates and click it
    console.log('Looking for Download button...');
    const buttonInfo = await this.page.evaluate(() => {
      // Find by data-testid first
      let btn = document.querySelector('button[data-testid="@ai-playground-v2/download-button"]');

      // Fallback to text search
      if (!btn) {
        const buttons = document.querySelectorAll('button');
        for (const b of buttons) {
          if (b.textContent.includes('Download') && b.offsetParent !== null) {
            btn = b;
            break;
          }
        }
      }

      if (btn) {
        const rect = btn.getBoundingClientRect();
        return {
          found: true,
          x: rect.x + rect.width / 2,
          y: rect.y + rect.height / 2,
          text: btn.textContent.trim().substring(0, 50)
        };
      }
      return { found: false };
    });

    if (!buttonInfo.found) {
      console.log('Download button not found');
      await this.takeScreenshot('veed-no-download-btn.png');
      throw new Error('Download button not found');
    }

    console.log(`Found Download button: "${buttonInfo.text}" at (${buttonInfo.x}, ${buttonInfo.y})`);
    console.log('Clicking Download button...');

    // Click using coordinates
    await this.page.mouse.click(buttonInfo.x, buttonInfo.y);

    // Wait for download to start
    console.log('Waiting for download to initiate...');
    await new Promise(r => setTimeout(r, 5000));

    // Take screenshot
    await this.takeScreenshot('veed-after-download-click.png');

    // Check if CDP detected a download
    console.log(`CDP download started: ${downloadStarted}, completed: ${downloadComplete}`);

    // If CDP didn't detect a download, use fallback: fetch from page context
    if (!downloadStarted && videoUrl) {
      console.log('CDP did not detect download, trying fetch fallback...');

      try {
        // Use page.evaluate to fetch the video with credentials
        const videoData = await this.page.evaluate(async (url) => {
          try {
            const response = await fetch(url, {
              credentials: 'include',
              headers: {
                'Accept': 'video/mp4,video/*,*/*'
              }
            });

            if (!response.ok) {
              return { error: `Fetch failed: ${response.status} ${response.statusText}` };
            }

            const blob = await response.blob();
            const arrayBuffer = await blob.arrayBuffer();
            const uint8Array = new Uint8Array(arrayBuffer);

            // Convert to base64 for transfer (in chunks to avoid memory issues)
            const chunkSize = 1024 * 1024; // 1MB chunks
            let binary = '';
            for (let i = 0; i < uint8Array.length; i++) {
              binary += String.fromCharCode(uint8Array[i]);
            }
            return { data: btoa(binary), size: uint8Array.length, type: blob.type };
          } catch (e) {
            return { error: e.message };
          }
        }, videoUrl);

        if (videoData.error) {
          console.log('Fetch fallback error:', videoData.error);
        } else {
          console.log(`Fetched video data: ${videoData.size} bytes, type: ${videoData.type}`);
          const filename = `veed-${Date.now()}.mp4`;
          const filePath = path.join(videosDir, filename);
          const buffer = Buffer.from(videoData.data, 'base64');
          fs.writeFileSync(filePath, buffer);
          console.log(`Video saved via fetch fallback: ${filePath}`);
          return `/videos/${filename}`;
        }
      } catch (e) {
        console.log('Fetch fallback exception:', e.message);
      }
    }

    // Wait for CDP download or file to appear
    const timeout = 60000; // 1 minute
    const startTime = Date.now();
    let downloadedFile = null;

    console.log('Waiting for download to complete...');
    while (Date.now() - startTime < timeout) {
      await new Promise(r => setTimeout(r, 1000));

      // Check CDP completion - file is saved with GUID name
      if (downloadComplete && downloadGuid) {
        console.log(`CDP confirmed download: GUID=${downloadGuid}, suggested=${downloadedFilename}`);

        // The file is saved with the GUID as filename
        const guidFilePath = path.join(videosDir, downloadGuid);
        if (fs.existsSync(guidFilePath)) {
          // Rename to a proper filename with .mp4 extension
          const newFilename = `veed-${Date.now()}.mp4`;
          const newFilePath = path.join(videosDir, newFilename);
          fs.renameSync(guidFilePath, newFilePath);
          console.log(`Renamed ${downloadGuid} to ${newFilename}`);
          downloadedFile = newFilename;
          break;
        }
      }

      const filesAfter = fs.readdirSync(videosDir);

      // Find new files (GUID files won't have extension)
      for (const file of filesAfter) {
        if (!filesBefore.has(file) &&
            !file.endsWith('.crdownload') &&
            !file.endsWith('.tmp')) {
          const filePath = path.join(videosDir, file);
          const size1 = fs.statSync(filePath).size;
          await new Promise(r => setTimeout(r, 500));

          try {
            const size2 = fs.statSync(filePath).size;
            if (size1 === size2 && size1 > 1000) {
              // If it's a GUID file (no extension), rename it
              if (!file.includes('.')) {
                const newFilename = `veed-${Date.now()}.mp4`;
                const newFilePath = path.join(videosDir, newFilename);
                fs.renameSync(filePath, newFilePath);
                console.log(`Renamed ${file} to ${newFilename}`);
                downloadedFile = newFilename;
              } else {
                downloadedFile = file;
              }
              break;
            }
          } catch (e) {
            // File might have been renamed
          }
        }
      }

      if (downloadedFile) break;

      const elapsed = Math.floor((Date.now() - startTime) / 1000);
      if (elapsed % 10 === 0 && elapsed > 0) {
        console.log(`Waiting... (${elapsed}s) CDP started: ${downloadStarted}`);
      }
    }

    if (!downloadedFile) {
      console.log('Download failed');
      const finalFiles = fs.readdirSync(videosDir);
      console.log('Files in directory:', finalFiles);
      throw new Error('Download failed - no file downloaded');
    }

    const localPath = path.join(videosDir, downloadedFile);
    const stats = fs.statSync(localPath);
    console.log(`Video downloaded: ${localPath} (${(stats.size / 1024 / 1024).toFixed(2)} MB)`);

    return `/videos/${downloadedFile}`;
  }

  // Download image from URL to a temp file
  async downloadImage(imageUrl) {
    const tempPath = path.join(__dirname, `temp-image-${Date.now()}.png`);

    return new Promise((resolve, reject) => {
      const protocol = imageUrl.startsWith('https') ? https : http;

      const file = fs.createWriteStream(tempPath);
      protocol.get(imageUrl, (response) => {
        response.pipe(file);
        file.on('finish', () => {
          file.close();
          resolve(tempPath);
        });
      }).on('error', (err) => {
        fs.unlink(tempPath, () => {});
        reject(err);
      });
    });
  }

  // Generate video from image using Veed.io
  async generateVideo(imageUrl, prompt, options = {}) {
    if (!this.page) throw new Error('Service not initialized');
    if (!this.isAuthenticated) throw new Error('Not authenticated');

    const { aspectRatio = 'portrait', duration = '5' } = options;

    console.log('Starting video generation...');
    console.log('Image URL:', imageUrl);
    console.log('Prompt:', prompt);

    // Retry logic for page load
    const maxRetries = 3;
    let lastError = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        console.log(`Attempt ${attempt}/${maxRetries}: Navigating to AI Playground...`);

        // Navigate to image-to-video page
        await this.page.goto(VEED_IMAGE_TO_VIDEO_URL, {
          waitUntil: 'networkidle2',
          timeout: 30000,
        });

        // Check for error page
        const hasError = await this.page.evaluate(() => {
          return document.body.innerText.includes('Something went wrong') ||
                 document.body.innerText.includes('error') && document.body.innerText.length < 500;
        });

        if (hasError) {
          console.log('Error page detected, retrying...');
          await new Promise(r => setTimeout(r, 2000));
          continue;
        }

        // Wait for page to load
        await this.page.waitForSelector('textarea#prompt', { timeout: 15000 });
        console.log('Page loaded, prompt textarea found');
        break; // Success, exit retry loop

      } catch (error) {
        lastError = error;
        console.log(`Attempt ${attempt} failed: ${error.message}`);
        if (attempt < maxRetries) {
          await new Promise(r => setTimeout(r, 2000));
        }
      }
    }

    if (lastError && !(await this.page.$('textarea#prompt'))) {
      throw lastError;
    }

    try {

      // Download the image to a temp file if it's a URL
      let imagePath = imageUrl;
      if (imageUrl.startsWith('http')) {
        console.log('Downloading image...');
        imagePath = await this.downloadImage(imageUrl);
        console.log('Image downloaded to:', imagePath);
      }

      // Find and trigger the file input
      const fileInput = await this.page.$('input[type="file"][accept*="image"]');
      if (!fileInput) {
        throw new Error('File input not found');
      }

      // Upload the image
      console.log('Uploading image...');
      await fileInput.uploadFile(imagePath);

      // Wait for upload to complete - the "Uploading image..." text should disappear
      // and be replaced with the uploaded image thumbnail
      console.log('Waiting for upload to complete...');
      await this.waitForUploadComplete(30000);
      console.log('Image uploaded successfully');

      // Clean up temp file
      if (imagePath !== imageUrl && fs.existsSync(imagePath)) {
        fs.unlinkSync(imagePath);
      }

      // Wait for UI to stabilize after upload
      await new Promise(r => setTimeout(r, 2000));

      // Select 16:9 aspect ratio (landscape)
      console.log('Selecting 16:9 aspect ratio...');
      try {
        // The aspect ratio is controlled by a hidden select element
        // Set the value to "landscape" for 16:9
        const selected = await this.page.evaluate(() => {
          // Find the hidden select with aspect ratio options
          const selects = document.querySelectorAll('select');
          for (const select of selects) {
            const options = select.querySelectorAll('option');
            for (const opt of options) {
              if (opt.value === 'landscape' || opt.textContent.includes('16:9')) {
                select.value = 'landscape';
                // Trigger change event
                select.dispatchEvent(new Event('change', { bubbles: true }));
                return { success: true, value: select.value };
              }
            }
          }
          return { success: false };
        });

        if (selected.success) {
          console.log(`16:9 aspect ratio selected (value: ${selected.value})`);
          await new Promise(r => setTimeout(r, 500));
        } else {
          // Fallback: try clicking the visible UI element
          const clicked = await this.page.evaluate(() => {
            const elements = document.querySelectorAll('div, span, button');
            for (const el of elements) {
              if (el.textContent.includes('16:9') && el.offsetParent !== null) {
                el.click();
                return true;
              }
            }
            return false;
          });
          if (clicked) {
            console.log('16:9 selected via UI click');
          } else {
            console.log('Could not find 16:9 option');
          }
        }
      } catch (e) {
        console.log('Error selecting aspect ratio:', e.message);
      }

      // Enter the prompt
      console.log('Entering prompt...');
      const promptTextarea = await this.page.$('textarea#prompt');
      await promptTextarea.click({ clickCount: 3 }); // Select all
      await promptTextarea.type(prompt);

      // Wait for Generate button to be enabled
      console.log('Waiting for Generate button to be ready...');
      await this.page.waitForFunction(() => {
        const btn = document.querySelector('button[type="submit"]');
        return btn && !btn.disabled;
      }, { timeout: 10000 });

      // Take a screenshot before generating
      await this.takeScreenshot('veed-before-generate.png');

      // Click the Generate button with retry
      console.log('Clicking Generate button...');
      const generateButton = await this.page.$('button[type="submit"]');
      if (!generateButton) {
        throw new Error('Generate button not found');
      }
      await generateButton.click();

      // Wait a moment and verify generation started
      await new Promise(r => setTimeout(r, 2000));

      // Wait for video generation to complete
      console.log('Waiting for video generation (this may take a while)...');

      // The video element or download link should appear when done
      // We need to wait for the video to be generated - this could take 30-120 seconds
      const videoResult = await this.waitForVideoResult(180000); // 3 minute timeout

      return videoResult;

    } catch (error) {
      console.error('Video generation error:', error.message);
      await this.takeScreenshot('veed-error.png');
      throw error;
    }
  }

  // Wait for image upload to complete
  async waitForUploadComplete(timeout = 30000) {
    const startTime = Date.now();

    while (Date.now() - startTime < timeout) {
      try {
        // Check if upload is still in progress
        const uploadStatus = await this.page.evaluate(() => {
          // Look for "Uploading image..." text
          const uploadingText = document.body.innerText.includes('Uploading image');

          // Look for uploaded image indicator - check for image preview or success state
          // The page shows a thumbnail after upload completes
          const imagePreview = document.querySelector('img[src*="blob:"], img[src*="data:"], img[src*="veed"]');
          const hasUploadedImage = imagePreview !== null;

          // Check for any image container that indicates upload success
          const imageContainer = document.querySelector('[class*="upload"] img, [class*="preview"] img, [class*="thumbnail"]');

          return {
            uploading: uploadingText,
            hasImage: hasUploadedImage || imageContainer !== null
          };
        });

        if (!uploadStatus.uploading && uploadStatus.hasImage) {
          return true;
        }

        // Also check if we can find the prompt textarea is now active/ready
        const promptReady = await this.page.evaluate(() => {
          const textarea = document.querySelector('textarea#prompt');
          // Check if the Generate button is enabled (usually disabled until image is uploaded)
          const generateBtn = document.querySelector('button[type="submit"]');
          const isEnabled = generateBtn && !generateBtn.disabled;
          return textarea !== null && isEnabled;
        });

        if (promptReady) {
          // Give it a tiny bit more time to stabilize
          await new Promise(r => setTimeout(r, 1000));
          return true;
        }

        await new Promise(r => setTimeout(r, 1000));
      } catch (error) {
        // Continue waiting
      }
    }

    throw new Error('Image upload timed out');
  }

  // Wait for the video result after clicking generate
  async waitForVideoResult(timeout = 180000) {
    const startTime = Date.now();
    let lastProgress = '';
    let lastLogTime = 0;
    let screenshotCount = 0;

    console.log(`[waitForVideoResult] Starting wait with ${timeout/1000}s timeout...`);

    while (Date.now() - startTime < timeout) {
      const elapsed = Math.floor((Date.now() - startTime) / 1000);

      try {
        // Comprehensive page state check
        const pageState = await this.page.evaluate(() => {
          const result = {
            videos: [],
            progress: null,
            status: null,
            isGenerating: false,
            hasError: false,
            errorText: null,
            pageText: '',
          };

          // Find all video elements and their sources
          const videos = document.querySelectorAll('video');
          videos.forEach((video, idx) => {
            const sources = [];
            if (video.src) sources.push(video.src);
            video.querySelectorAll('source').forEach(s => {
              if (s.src) sources.push(s.src);
            });
            // Also check currentSrc
            if (video.currentSrc) sources.push(video.currentSrc);

            result.videos.push({
              index: idx,
              sources: [...new Set(sources)],
              readyState: video.readyState,
              duration: video.duration,
            });
          });

          // Get page text for analysis
          const bodyText = document.body.innerText || '';
          result.pageText = bodyText.substring(0, 500);

          // Look for progress percentage
          const percentMatches = bodyText.match(/(\d+)\s*%/g);
          if (percentMatches) {
            result.progress = percentMatches[percentMatches.length - 1]; // Get last percentage
          }

          // Check for various status indicators
          const statusKeywords = ['Generating', 'Processing', 'Creating', 'Loading', 'Rendering', 'Queued', 'Starting'];
          for (const keyword of statusKeywords) {
            if (bodyText.includes(keyword)) {
              result.status = keyword;
              result.isGenerating = true;
              break;
            }
          }

          // Check for progress bars or loading spinners
          const progressBar = document.querySelector('[role="progressbar"], [class*="progress"], [class*="Progress"]');
          if (progressBar) {
            result.isGenerating = true;
            const ariaValue = progressBar.getAttribute('aria-valuenow');
            if (ariaValue) result.progress = ariaValue + '%';
          }

          // Check for loading/spinner elements
          const spinner = document.querySelector('[class*="spinner"], [class*="Spinner"], [class*="loading"], [class*="Loading"], svg[class*="animate"]');
          if (spinner) {
            result.isGenerating = true;
          }

          // Check for error states
          const errorEl = document.querySelector('[role="alert"], [class*="error"], [class*="Error"], [data-testid*="error"]');
          if (errorEl) {
            result.hasError = true;
            result.errorText = errorEl.textContent?.trim().substring(0, 200);
          }

          // Check for "failed" or "error" in text
          if (bodyText.toLowerCase().includes('failed') || bodyText.toLowerCase().includes('error occurred')) {
            result.hasError = true;
            result.errorText = result.errorText || 'Generation may have failed';
          }

          return result;
        });

        // Check for completed video
        for (const video of pageState.videos) {
          for (const src of video.sources) {
            if (src && (src.includes('.mp4') || src.includes('video') || src.includes('blob:'))) {
              // Found a video source - but make sure it's not a placeholder
              if (!src.includes('placeholder') && !src.includes('preview')) {
                console.log(`[waitForVideoResult] Video found after ${elapsed}s:`, src.substring(0, 100));
                await this.takeScreenshot('veed-video-ready.png');

                // Download the video
                const localPath = await this.downloadVideoWithButton();

                return {
                  success: true,
                  videoUrl: src,
                  localPath: localPath,
                };
              }
            }
          }
        }

        // Check for errors
        if (pageState.hasError && pageState.errorText) {
          console.error(`[waitForVideoResult] Error detected: ${pageState.errorText}`);
          await this.takeScreenshot('veed-error.png');
          throw new Error(`Veed error: ${pageState.errorText}`);
        }

        // Log progress
        const currentProgress = pageState.progress || pageState.status || 'waiting';
        const shouldLog = Date.now() - lastLogTime > 5000; // Log every 5 seconds

        if (shouldLog || currentProgress !== lastProgress) {
          console.log(`[waitForVideoResult] ${elapsed}s - Progress: ${currentProgress}, Videos: ${pageState.videos.length}, Generating: ${pageState.isGenerating}`);
          lastProgress = currentProgress;
          lastLogTime = Date.now();
        }

        // Take periodic screenshots for debugging (every 30 seconds)
        if (elapsed > 0 && elapsed % 30 === 0 && screenshotCount < elapsed / 30) {
          screenshotCount = Math.floor(elapsed / 30);
          await this.takeScreenshot(`veed-progress-${elapsed}s.png`);
          console.log(`[waitForVideoResult] Screenshot saved: veed-progress-${elapsed}s.png`);
        }

        // If not generating and no video after 30 seconds, something might be wrong
        if (elapsed > 30 && !pageState.isGenerating && pageState.videos.length === 0) {
          console.log(`[waitForVideoResult] Warning: No generation activity detected. Page text: ${pageState.pageText.substring(0, 200)}`);
        }

        // Wait before next check
        await new Promise(r => setTimeout(r, 2000));

      } catch (error) {
        if (error.message.includes('Veed error')) {
          throw error;
        }
        console.error(`[waitForVideoResult] Check error at ${elapsed}s:`, error.message);
        // Continue waiting
      }
    }

    // Timeout - take final screenshot
    await this.takeScreenshot('veed-timeout.png');
    throw new Error('Video generation timed out after ' + (timeout/1000) + ' seconds');
  }

  async close() {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
      this.page = null;
      this.isAuthenticated = false;
      console.log('Veed.io service closed');
    }
  }
}

// Export singleton instance
let veedService = null;

export async function getVeedService() {
  if (!veedService) {
    veedService = new VeedService();
  }
  return veedService;
}

export async function initVeedService() {
  const service = await getVeedService();
  return await service.initialize();
}

// Test script - run directly with: node server/veed-service.js
if (import.meta.url === `file://${process.argv[1]}`) {
  console.log('Running Veed.io service test...\n');

  const service = new VeedService();

  try {
    const authenticated = await service.initialize();

    if (authenticated) {
      console.log('\n✓ Successfully authenticated with Veed.io!');

      // Take a screenshot to verify
      const screenshotPath = await service.takeScreenshot();
      console.log(`\nScreenshot saved to: ${screenshotPath}`);
    } else {
      console.log('\n✗ Authentication failed. Please check your cookies.');
    }

  } catch (error) {
    console.error('\nError:', error.message);
  } finally {
    await service.close();
    process.exit(0);
  }
}

export default VeedService;
