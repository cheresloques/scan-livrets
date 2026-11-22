# Scans : consignes pour les sessions Claude

Les pages scannées par l'appli Scan Livrets arrivent dans le Drive de Pierre :

```
Claude / Scans / <projet> / <livret> /
    couleur/    pNNN.jpg        page redressée, en couleur (illustrations, mise en page)
    lecture/    pNNN.jpg|png    version contrastée : c'est elle qu'il faut lire
    images/     pNNN-imgK.jpg   illustrations découpées automatiquement
    texte-lu/   pNNN.txt        lecture automatique du téléphone : brouillon peu fiable
    rapport.json                état de chaque page (alertes, pages gardées malgré une alerte)
```

## Lire les pages

- Le texte fiable s'obtient en lisant l'image du dossier `lecture` avec l'outil Drive
  (lecture du contenu du fichier) : bien meilleur que `texte-lu`.
- Les numéros `pNNN` sont l'ordre de prise, pas la pagination du livret. Se repérer au
  numéro imprimé en bas de page. Il peut y avoir des doublons ou des pages prises en
  plusieurs morceaux (photo simple) : garder la meilleure version, recoller les morceaux.
- Une page sans numéro imprimé (grande illustration) : demander à Pierre en cas de doute.

## Une fois des pages traitées

Mettre **à la corbeille** tous les fichiers de ces pages (`couleur`, `lecture`, `images`,
`texte-lu` pour chaque pNNN traité), ne pas les supprimer définitivement.

- La corbeille du Drive se vide seule au bout de 30 jours : Pierre peut récupérer une page
  pendant un mois.
- Au prochain « Synchroniser avec Drive » dans l'appli, les pages dont les fichiers sont à la
  corbeille sont retirées du téléphone.
- Ne rien ajouter d'autre dans les sous-dossiers `couleur`, `lecture`, `images`, `texte-lu` :
  « Synchroniser » met à la corbeille tout fichier qu'il ne connaît pas.
