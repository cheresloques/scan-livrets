// Copie les fichiers de l'appli web dans www/ (dossier embarqué dans l'APK).
import { cpSync, rmSync, mkdirSync } from 'node:fs';
const files = ['index.html', 'styles.css', 'config.js', 'app.js', 'vision-core.js', 'vision-worker.js',
  'manifest.webmanifest', 'sw.js', 'oauth.html', 'lib', 'icons'];
rmSync('www', { recursive: true, force: true });
mkdirSync('www');
for (const f of files) cpSync(f, 'www/' + f, { recursive: true });
console.log('www/ prêt');
