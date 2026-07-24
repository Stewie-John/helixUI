const fs = require('fs');
const path = require('path');

// Icon sizes needed
const sizes = [72, 96, 128, 144, 152, 192, 384, 512];

// SVG template function
function createIconSVG(size) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 512 512" fill="none" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="c" x1="128" y1="64" x2="384" y2="448" gradientUnits="userSpaceOnUse">
      <stop stop-color="#26F7E8"/><stop offset="1" stop-color="#14A8FF"/>
    </linearGradient>
    <linearGradient id="p" x1="384" y1="64" x2="128" y2="448" gradientUnits="userSpaceOnUse">
      <stop stop-color="#FF78D7"/><stop offset="1" stop-color="#9B7BFF"/>
    </linearGradient>
  </defs>
  <rect width="512" height="512" fill="#061426"/>
  <rect x="28" y="28" width="456" height="456" rx="116" fill="#07192B" stroke="#0C7899" stroke-width="16"/>
  <path d="M144 64C144 144 368 144 368 224C368 304 144 304 144 384C144 424 184 448 256 464"
        stroke="url(#c)" stroke-width="40" stroke-linecap="round"/>
  <path d="M368 64C368 144 144 144 144 224C144 304 368 304 368 384C368 424 328 448 256 464"
        stroke="url(#p)" stroke-width="40" stroke-linecap="round"/>
  <path d="M176 120H336M176 200H336M176 288H336M176 376H336"
        stroke="#71F8C5" stroke-width="20" stroke-linecap="round" opacity=".9"/>
</svg>`;
}

// Generate SVG files for each size
sizes.forEach(size => {
  const svgContent = createIconSVG(size);
  const filename = `icon-${size}x${size}.svg`;
  const filepath = path.join(__dirname, 'icons', filename);
  
  fs.writeFileSync(filepath, svgContent);
  console.log(`Created ${filename}`);
});

console.log('\nSVG icons created! To convert to PNG, you can use:');
console.log('1. Online converter like cloudconvert.com');
console.log('2. If you have ImageMagick: convert icon.svg icon.png');
console.log('3. If you have Inkscape: inkscape --export-type=png icon.svg');
