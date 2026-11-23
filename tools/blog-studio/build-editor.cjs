const esbuild = require('esbuild');
const path = require('path');
esbuild.buildSync({entryPoints:[path.join(__dirname,'web/editor-source.js')],bundle:true,minify:true,legalComments:'eof',outfile:path.join(__dirname,'web/editor-bundle.js'),target:['es2020']});
