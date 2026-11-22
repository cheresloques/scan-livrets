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

Retirer leurs fichiers des dossiers de travail (`couleur`, `lecture`, `images`, `texte-lu`),
pour chaque pNNN traité, de l'une de ces deux façons :

- **Encore besoin des fichiers** : les déplacer dans un dossier à côté, par exemple
  `<livret> - traités` (au même niveau que le dossier du livret, pas dedans).
- **Plus besoin** : les mettre **à la corbeille** (jamais de suppression définitive). La
  corbeille du Drive se vide seule au bout de 30 jours : Pierre peut récupérer une page pendant
  un mois.

Ne jamais déplacer ou renommer les dossiers de travail eux-mêmes : seulement les fichiers.

Au prochain « Synchroniser avec Drive » dans l'appli, les pages dont les fichiers ont quitté les
dossiers de travail (corbeille ou déplacement) sont retirées du téléphone, sans toucher au Drive.

Ne rien ajouter d'autre dans les dossiers de travail : « Synchroniser » met à la corbeille tout
fichier qu'il ne connaît pas.
