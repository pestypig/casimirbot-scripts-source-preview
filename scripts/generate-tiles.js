// scripts/generate-tiles.js
import sharp from 'sharp';
import fs from 'fs';
import path from 'path';

async function generateTiles() {
  const inputPath = 'client/public/galaxymap.png';
  const outputDir = 'client/public/galaxy_tiles';
  
  if (!fs.existsSync(inputPath)) {
    console.error('Galaxy map not found at:', inputPath);
    process.exit(1);
  }

  console.log('Generating Deep Zoom tiles for galaxy map...');
  
  try {
    await sharp(inputPath)
      .tile({
        size: 512,        // 512x512 tiles
        overlap: 1,       // 1px overlap
        layout: 'dz'      // Deep Zoom format
      })
      .toFile(outputDir);
    
    console.log('✓ Tiles generated successfully at:', outputDir);
    console.log('✓ DZI descriptor created at:', outputDir + '.dzi');
    
    // Create a simple info file
    const metadata = await sharp(inputPath).metadata();
    fs.writeFileSync(path.join('client/public', 'galaxy_info.json'), JSON.stringify({
      originalSize: { width: metadata.width, height: metadata.height },
      tileSize: 512,
      generated: new Date().toISOString()
    }, null, 2));
    
  } catch (error) {
    console.error('Error generating tiles:', error);
    process.exit(1);
  }
}

generateTiles();