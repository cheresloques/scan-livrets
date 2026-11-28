# Scan Livrets

Appli web installable (Android) pour numériser des livrets et documents papier vers Google Drive
(premier usage : les livrets d'Aeon Trespass, pour leur traduction).

- Détection de la page et déclenchement automatique dès qu'elle est stable
- Contrôle de chaque page : flou, reflet, ombre, page coupée, format
- Deux versions par page : couleur (illustrations) et lecture (contraste poussé)
- Mode « livret ouvert sur support » : une photo de la double page donne deux pages (gauche puis droite),
  coupées au niveau du pli, avec un signal sonore quand les deux sont bonnes
- Recadrage identique avec une marge autour de la page ; bouton photo simple (image entière)
- Illustrations découpées automatiquement (modifiables à la main)
- Envoi automatique dans Google Drive : `Claude / Scans / <projet> / <livret>/`
- Sélection multiple, suppression par lot, bouton « Synchroniser avec Drive »

Tout le traitement se fait sur le téléphone. Aucun scan ne passe par ce dépôt.
Consignes pour les sessions Claude qui utilisent les scans : [CONSIGNES-SESSIONS.md](CONSIGNES-SESSIONS.md).

Bibliothèques embarquées : OpenCV.js 4.10, Tesseract.js 5.1.1, JSZip 3.10.1.

## Appli Android (APK, mises à jour par Obtainium)

La même appli existe en APK, construite par GitHub à chaque nouvelle version (`VERSION` dans `app.js`)
et publiée dans les [Releases](https://github.com/cheresloques/scan-livrets/releases).
Dans Obtainium : « Ajouter une appli », URL `https://github.com/cheresloques/scan-livrets`.

- Emballage : Capacitor (`capacitor.config.json`, dossier `android/`). `npm run sync` copie l'appli web dans `www/`.
- Connexion Google : Google refuse la connexion dans une WebView, elle se fait donc dans un onglet Chrome ;
  Google renvoie le jeton à `oauth.html` (sur GitHub Pages), qui le repasse à l'appli (`scanlivrets://oauth`).
  L'adresse `https://cheresloques.github.io/scan-livrets/oauth.html` doit figurer dans les
  « URI de redirection autorisés » du client OAuth.
- Signature : clé `android/keystore/scan-livrets.p12`, mot de passe dans le secret GitHub `ANDROID_KEYSTORE_PASSWORD`.
  Ne jamais changer de clé : Android refuserait la mise à jour.
