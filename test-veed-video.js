import VeedService from './veed-service.js';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Image path - use the pfp.jpeg from assets
const IMAGE_PATH = path.resolve(__dirname, '../../assets/pfp.jpeg');

async function testVideoGeneration() {
  console.log('=== VEED Video Generation Test ===\n');
  console.log('Image path:', IMAGE_PATH);

  const service = new VeedService();

  try {
    // Initialize and authenticate
    console.log('\n1. Initializing service...');
    const authenticated = await service.initialize();

    if (!authenticated) {
      console.error('Authentication failed. Please check your cookies.');
      process.exit(1);
    }
    console.log('Authentication successful!\n');

    // Generate video
    console.log('2. Starting video generation...');
    const result = await service.generateVideo(
      IMAGE_PATH,
      'Gentle subtle movement, slight head turn, natural blinking eyes',
      { aspectRatio: 'portrait', duration: '5' }
    );

    console.log('\n=== Result ===');
    console.log('Success:', result.success);
    console.log('Video URL:', result.videoUrl);
    console.log('Local Path:', result.localPath);

  } catch (error) {
    console.error('\nError:', error.message);
    console.error(error.stack);
  } finally {
    await service.close();
    console.log('\nService closed.');
    process.exit(0);
  }
}

testVideoGeneration();
