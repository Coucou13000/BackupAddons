# Nuvio Failover Addon — v2

Une page web pour créer des **blocs d'addons** : chaque bloc regroupe plusieurs manifests
d'un même addon (ex. 3 instances d'AIOMetadata sur des hosts différents). Si un manifest
ne répond pas, le suivant du bloc prend le relais automatiquement — Nuvio ne voit qu'une
seule URL par bloc, tout le reste est invisible.

Tu peux créer autant de blocs que tu veux (un pour AIOMetadata, un pour AIOStreams, etc.),
et dans chaque bloc autant de manifests que tu veux.

## Espace privé

Cet outil est fait pour être utilisé par plusieurs personnes sur le même déploiement,
sans que personne ne voie les blocs des autres. Au premier chargement, la page génère
une clé aléatoire, l'ajoute à l'URL (`?key=...`) et la garde en mémoire dans le
navigateur. Toutes tes actions (lecture, écriture, URLs d'installation) passent par
cette clé — deux personnes peuvent nommer un bloc "wastream" chacune de leur côté sans
aucun conflit, et personne ne peut voir la config de personne d'autre sans connaître sa
clé exacte.

**Garde ton URL complète (avec le `?key=...`) quelque part** — c'est elle qui te
redonne accès à tes blocs. Si tu la perds et vides le cache de ton navigateur, tu ne
pourras pas la retrouver (il n'y a pas de mot de passe ni de compte à récupérer).

## Lancer en local

```bash
npm install
npm start
```

Ouvre `http://localhost:7000` : c'est la page d'administration.

## Utiliser la page

1. Clique **+ Nouveau bloc**, donne-lui un nom (ex. "AIOMetadata").
2. Colle l'URL du manifest.json de ta première instance.
3. Clique **+ Ajouter un manifest** pour chaque host de secours supplémentaire —
   l'ordre = l'ordre d'essai (le n°1 est tenté en premier).
4. Clique **Enregistrer** en bas de page.
5. Une URL apparaît dans le bloc, du type `http://ton-domaine/addon/aiometadata/manifest.json`
   — c'est celle-là que tu colles dans Nuvio (**Account → Addons → Add Addon**).

Répète pour d'autres addons si besoin (chaque bloc = une URL Nuvio différente).

La configuration est sauvegardée côté serveur dans `config.json` — pas besoin de
redéployer pour ajouter ou modifier un bloc, tout se fait depuis la page.

## Déployer pour que Nuvio y accède

Il faut une URL publique en HTTPS, avec le serveur qui tourne en continu (pas de
plateforme purement "serverless" type Vercel, qui ne convient pas à un process Express
classique).

### Render.com (gratuit, recommandé)
1. Pousse ce dossier sur un repo GitHub.
2. Sur https://render.com → "New +" → "Web Service" → connecte le repo.
3. Build command : `npm install`
4. Start command : `npm start`
5. Render te donne une URL du type `https://ton-addon.onrender.com` — c'est ton
   domaine pour la page d'admin et pour les blocs.
6. Pour que la config survive aux redémarrages, vois la section
   **"Rendre la config persistante"** ci-dessous.

### Railway.app
Même principe, connecte le repo GitHub. Railway propose aussi un volume persistant à
attacher pour que `config.json` survive aux redéploiements.

### Un VPS que tu as déjà
```bash
npm install -g pm2
cd nuvio-failover-addon
npm install
pm2 start server.js --name nuvio-failover
pm2 save
```
Mets un reverse proxy HTTPS devant (nginx + certbot, ou Caddy qui gère le certificat
tout seul). Sur un VPS, `config.json` est stocké sur disque normalement, donc pas de
souci de persistance.

## Structure du projet

```
server.js          → serveur Express : page d'admin + API + proxy de secours
public/index.html  → page web
public/style.css   → style
public/app.js      → logique des blocs (ajout/suppression, sauvegarde)
config.json         → utilisé seulement si Upstash n'est pas configuré, ne pas éditer à la main
```

## Rendre la config persistante

Par défaut, la config est stockée dans `config.json` sur le disque du service.
**Sur le tier gratuit de Render, ce fichier repart à zéro à chaque fois que le
service s'endort après 15 min d'inactivité et se réveille** — pas seulement aux
redéploiements. Deux façons de régler ça, au choix :

### Option gratuite — Upstash Redis

[Upstash](https://upstash.com) offre une base Redis gratuite qui persiste vraiment
(contrairement au disque de Render). Le serveur bascule dessus automatiquement dès
que les variables d'environnement sont présentes — aucun changement de code.

1. Crée un compte gratuit sur https://upstash.com (pas de carte bancaire requise).
2. "Create Database" → choisis la région la plus proche de ton service Render →
   type Redis, tier gratuit.
3. Dans le dashboard de la base, onglet **REST API**, copie `UPSTASH_REDIS_REST_URL`
   et `UPSTASH_REDIS_REST_TOKEN`.
4. Sur Render : Settings de ton service → **Environment** → ajoute ces deux
   variables avec les valeurs copiées.
5. Redéploie. Dans les logs Render, tu dois voir :
   `Stockage config : Upstash Redis (persistant) ✓`

Le tier gratuit d'Upstash (10 000 commandes/jour) est largement suffisant pour cet
usage.

### Option payante — disque Render

Si tu préfères rester 100% sur Render sans service tiers :

1. Passe ton service sur un plan payant (Starter, ~7$/mois).
2. Onglet **Disks** → "Add Disk" → monte-le sur le dossier du projet (1 Go suffit,
   ~0,25$/mois en plus).
3. Redéploie. Le fichier `config.json` survira désormais aux redémarrages —
   aucun changement de code nécessaire : le serveur utilise le fichier local par
   défaut si aucune variable Upstash n'est définie.

## "Cannot GET /" au déploiement

Si la page d'accueil affiche `Cannot GET /` (ou une erreur 500 avec un message
expliquant que `public/` est introuvable), va voir l'onglet **Logs** de ton service
sur Render juste après un déploiement : le serveur affiche au démarrage si le dossier
`public/` a été trouvé, et liste son contenu s'il existe. Les causes les plus
fréquentes :

- Le dossier `public/` n'a pas été poussé sur le repo GitHub connecté à Render
  (vérifie sur GitHub que `public/index.html`, `public/style.css` et `public/app.js`
  apparaissent bien dans le repo).
- Le champ **"Root Directory"** dans les paramètres du service Render pointe sur le
  mauvais dossier (il doit pointer sur le dossier qui contient directement `server.js`
  et `package.json`).

## Limites à connaître

- Si **tous** les manifests d'un bloc sont en panne en même temps, ce bloc renvoie une
  erreur 502 à Nuvio (comme n'importe quel addon indisponible).
- Le "manifest préféré" de chaque bloc est mémorisé en RAM : un redémarrage du serveur
  repart sur le manifest n°1 en priorité — sans conséquence, juste une requête
  légèrement plus lente le temps de retrouver le bon host si celui-ci est tombé entretemps.
- La page d'admin n'a pas de mot de passe : si tu la déploies sur une URL publique,
  n'importe qui connaissant l'URL peut modifier tes blocs. Pour un usage perso, le plus
  simple est de garder l'URL du service secrète (Render/Railway génèrent des URLs peu
  devinables par défaut).
