see alang-specs.md for purpose of this projects


## goal
- Bau zuerst einen dünnen Durchstich. Parser, kanonische Textausgabe und TypeScript-Ausgabe für Hallo Welt und net.port.parse, bevor irgendein Prüfer existiert. Danach kommen Typprüfung, Effekte, Beispiele und zuletzt die Datenbank.
- Verschieb die zwei teuren Regeln. Der statische Beweis aus 5.2 und die Präfixprüfung aus 1.6 sind jeweils eigene Projekte. Starte mit Laufzeitprüfungen für alle Verträge.
- Rechne mit Lücken. Die Skizze legt vieles noch nicht fest: die genaue Form von const und extern fn, die Standardbibliothek, Kommentare und String-Escapes. Entscheide solche Fälle nach den sechs Prinzipien.

- Zwei Tests lohnen sich von Anfang an: 
	- die Beispiele aus der Spezifikation als erste Testfälle, 
	- der Rundlauf „parsen, ausgeben, wieder parsen ergibt dasselbe“ als Wächter über die kanonische Form
