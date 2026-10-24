# Für Lily — Mein Herz

Eine kleine deutschsprachige Liebesbrief- und Fotoalbum-Web-App. Die 13 gelieferten Bilder werden unverändert aus `private/photos/` geladen; es wurden keine Ersatz- oder KI-Bilder verwendet.

## Starten

Voraussetzung: Node.js 18 oder neuer. Es gibt keine zusätzlichen Paketabhängigkeiten.

```bash
npm start
```

Die App läuft standardmäßig auf `http://localhost:4173`. Ein anderer Port kann über `PORT` gesetzt werden.

## Code-Stufen

Die Start- und Album-Codes werden serverseitig geprüft und im Website-Interface nicht angezeigt. Die Standardwerte lassen sich in `server.js` ansehen oder mit `ACCESS_CODE` und `ALBUM_CODE` überschreiben.

Die Foto-Dateien liegen außerhalb von `public/` und werden erst über geschützte Bild-Endpunkte ausgeliefert, nachdem das Album-Codewort stimmt. Die Sitzung nutzt ein HttpOnly-Cookie plus einen Tab-Token als Fallback für Browser-/Preview-Umgebungen, die Cookies nicht zuverlässig behalten. Bilder werden beim Neuladen nicht wieder eingeblendet; das Album-Codewort muss auf jeder neuen Seitenansicht erneut eingegeben werden.

## Weitere Fotos ergänzen

1. Die Originaldatei unverändert in `private/photos/` legen.
2. Den Dateinamen am Ende von `PHOTO_FILES` in `server.js` ergänzen.

Nach dem Code öffnet sich das erste Foto in einem bildschirmfüllenden Foto-Viewer; die restliche Website bleibt normal im Hintergrund. Mit dem Schließen-Knopf oder Escape geht es zurück zum Album. Die Galerie zählt die Bilder automatisch, erstellt Miniaturansichten und nimmt jedes Bild in die Diashow auf. Fotos werden absichtlich nicht aus einem öffentlichen Ordner ausgeliefert.

## Musik

Die Diashow erzeugt eine leise, romantische Instrumental-Melodie lokal mit der Web Audio API. Es wird kein Musikstück von einer externen Quelle geladen. Browser blockieren Ton bis zu einer Nutzeraktion; deshalb startet die Melodie beim ersten Klick auf „Diashow starten“ oder „Musik einschalten“.
