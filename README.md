# Spelermatch

Iedereen kiest tegelijk een voetballer, daarna wordt alles tegelijk onthuld. Leg verbanden tussen de keuzes en probeer samen op dezelfde speler uit te komen.

- Inloggen met alleen een naam (wordt in de browser onthouden).
- Typ een naam, kies de juiste foto (opgehaald van Wikipedia).
- Als iedereen die online is gekozen heeft, verschijnt de knop "Aftellen en tonen".
- Eerdere rondes blijven zichtbaar, zodat je verbanden kunt leggen.

## Starten

Vereist Node 18 of nieuwer, geen `npm install` nodig.

```bash
node server.js
```

Open daarna http://localhost:3000. Een andere poort: `PORT=8080 node server.js`.

## Online zetten

Het spel draait als één Node-proces en houdt de stand in het geheugen (een herstart wist het spel). Het werkt op elke host die een langlopend Node-proces draait, bijvoorbeeld Render, Railway of Fly.io: startcommando `node server.js`, de poort komt uit `PORT`.

Snel met vrienden spelen vanaf je eigen laptop kan ook met een tunnel:

```bash
npx cloudflared tunnel --url http://localhost:3000
```
