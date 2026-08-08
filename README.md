# Nuvio Failover Addon — v2

Une page web pour créer des **blocs d'addons** : chaque bloc regroupe plusieurs manifests
d'un même addon (ex. 3 instances d'AIOMetadata sur des hosts différents). Si un manifest
ne répond pas, le suivant du bloc prend le relais automatiquement — Nuvio ne voit qu'une
seule URL par bloc, tout le reste est invisible.

Tu peux créer autant de blocs que tu veux (un pour AIOMetadata, un pour AIOStreams, etc.),
et dans chaque bloc autant de manifests que tu veux.

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
5. **Important** : ajoute un "Persistent Disk" (même petit, 1 Go suffit) monté sur le
   dossier du projet, sinon `config.json` repart à zéro à chaque redéploiement.
6. Render te donne une URL du type `https://ton-addon.onrender.com` — c'est ton
   domaine pour la page d'admin et pour les blocs.

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
config.json         → généré/mis à jour automatiquement, ne pas éditer à la main
```

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
