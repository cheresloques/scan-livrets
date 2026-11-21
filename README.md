# Scan Livrets

Appli web installable (Android) pour numériser les livrets d'Aeon Trespass avant traduction.

- Détection du livret et déclenchement automatique dès que la page est stable
- Contrôle de chaque page : flou, reflet, ombre, page coupée, format, lisibilité du texte
- Deux versions par page : couleur (pour les illustrations) et lecture (contraste poussé)
- Recadrage identique : le premier bon cadrage fixe le format du livret
- Illustrations découpées automatiquement (modifiables à la main)
- Envoi automatique dans Google Drive : `Claude / Scans Aeon Trespass / <livret>/`

Tout le traitement se fait sur le téléphone. Aucun scan ne passe par ce dépôt.

Bibliothèques embarquées : OpenCV.js 4.10, Tesseract.js 5.1.1, JSZip 3.10.1.
