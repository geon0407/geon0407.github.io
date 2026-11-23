// Builds the browser Studio into site/studio/ (published by GitHub Pages at /studio/).
const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');
const out = path.join(__dirname, '../../../site/studio');
fs.mkdirSync(out, {recursive: true});
esbuild.buildSync({
  entryPoints: [path.join(__dirname, 'src/app.js')], bundle: true, minify: true, format: 'iife',
  legalComments: 'eof', target: ['es2020'], outfile: path.join(out, 'app.js'),
});
fs.copyFileSync(path.join(__dirname, 'index.html'), path.join(out, 'index.html'));
fs.writeFileSync(path.join(out, 'studio.css'),
  fs.readFileSync(path.join(__dirname, '../web/studio.css'), 'utf8') + fs.readFileSync(path.join(__dirname, 'webapp.css'), 'utf8'));
fs.copyFileSync(path.join(__dirname, '../THIRD-PARTY-NOTICES.txt'), path.join(out, 'THIRD-PARTY-NOTICES.txt'));
console.log('built', path.relative(process.cwd(), out));
