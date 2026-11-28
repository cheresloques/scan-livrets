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
