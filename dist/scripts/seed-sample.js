/**
 * Seed the BfDI database with sample decisions and guidelines for testing.
 *
 * Includes real BfDI and DSK decisions (Clearview AI, H&M, 1&1 Telecom)
 * and representative guidance documents so MCP tools can be tested without
 * running a full data ingestion pipeline.
 *
 * Usage:
 *   npx tsx scripts/seed-sample.ts
 *   npx tsx scripts/seed-sample.ts --force   # drop and recreate
 */
import Database from "better-sqlite3";
import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { SCHEMA_SQL } from "../src/db.js";
const DB_PATH = process.env["BFDI_DB_PATH"] ?? "data/bfdi.db";
const force = process.argv.includes("--force");
// --- Bootstrap database ------------------------------------------------------
const dir = dirname(DB_PATH);
if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
}
if (force && existsSync(DB_PATH)) {
    unlinkSync(DB_PATH);
    console.log(`Deleted existing database at ${DB_PATH}`);
}
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.exec(SCHEMA_SQL);
console.log(`Database initialised at ${DB_PATH}`);
const topics = [
    {
        id: "beschaeftigtendatenschutz",
        name_de: "Beschäftigtendatenschutz",
        name_en: "Employee data protection",
        description: "Datenschutz in der Beschäftigung — Bewerberdaten, Personalakten, Mitarbeiterüberwachung, Geodaten (§ 26 BDSG).",
    },
    {
        id: "datenuebermittlung",
        name_de: "Datenübermittlung",
        name_en: "Data transfers",
        description: "Übermittlung personenbezogener Daten an Dritte und in Drittländer (Art. 44–49 DSGVO, § 78–80 BDSG).",
    },
    {
        id: "einwilligung",
        name_de: "Einwilligung",
        name_en: "Consent",
        description: "Einwilligung als Rechtsgrundlage für die Verarbeitung personenbezogener Daten (Art. 7 DSGVO).",
    },
    {
        id: "videoueberwachung",
        name_de: "Videoüberwachung",
        name_en: "Video surveillance",
        description: "Videoüberwachung öffentlich zugänglicher Räume und in Unternehmen (§ 4 BDSG, Art. 6 DSGVO).",
    },
    {
        id: "gesundheitsdaten",
        name_de: "Gesundheitsdaten",
        name_en: "Health data",
        description: "Verarbeitung besonderer Kategorien personenbezogener Daten im Gesundheitsbereich (Art. 9 DSGVO).",
    },
    {
        id: "datenschutz_folgenabschaetzung",
        name_de: "Datenschutz-Folgenabschätzung",
        name_en: "Data Protection Impact Assessment",
        description: "Datenschutz-Folgenabschätzung (DSFA) für risikoreiche Verarbeitungen (Art. 35 DSGVO).",
    },
    {
        id: "auftragsverarbeitung",
        name_de: "Auftragsverarbeitung",
        name_en: "Data processing agreements",
        description: "Auftragsverarbeitung und Verträge mit Auftragsverarbeitern (Art. 28 DSGVO).",
    },
    {
        id: "cookies",
        name_de: "Cookies und Tracking",
        name_en: "Cookies and tracking",
        description: "Einsatz von Cookies und Tracking-Technologien im Internet (§ 25 TTDSG, Art. 6 DSGVO).",
    },
    {
        id: "betroffenenrechte",
        name_de: "Betroffenenrechte",
        name_en: "Data subject rights",
        description: "Rechte der betroffenen Personen: Auskunft, Berichtigung, Löschung, Widerspruch (Art. 12–22 DSGVO).",
    },
];
const insertTopic = db.prepare("INSERT OR IGNORE INTO topics (id, name_de, name_en, description) VALUES (?, ?, ?, ?)");
for (const t of topics) {
    insertTopic.run(t.id, t.name_de, t.name_en, t.description);
}
console.log(`Inserted ${topics.length} topics`);
const decisions = [
    // H&M — largest German GDPR fine at time
    {
        reference: "HH-2020-001",
        title: "Bußgeldbescheid — H&M Hennes & Mauritz AB & Co. KG (Beschäftigtendatenschutz)",
        date: "2020-10-01",
        type: "bussgeld",
        entity_name: "H&M Hennes & Mauritz AB & Co. KG",
        fine_amount: 35_258_708,
        summary: "Der Hamburgische Beauftragte für Datenschutz und Informationsfreiheit verhängte eine Geldbuße von 35,26 Millionen Euro gegen H&M wegen umfangreicher Überwachung und detaillierter Aufzeichnungen über das Privatleben von Mitarbeitern im Servicecenter Nürnberg. Nach Urlauben und Krankheiten wurden Mitarbeiter zu ihren Erlebnissen und teils sensiblen persönlichen Umständen befragt und diese Daten gespeichert.",
        full_text: "Der Hamburgische Beauftragte für Datenschutz und Informationsfreiheit (HmbBfDI) hat gegen die H&M Hennes & Mauritz AB & Co. KG eine Geldbuße in Höhe von 35.258.708 Euro verhängt. Im Servicecenter Nürnberg wurden ab dem Jahr 2014 teils sehr detaillierte Informationen über das Privatleben der Mitarbeiterinnen und Mitarbeiter erhoben und gespeichert. Nach Urlauben und krankheitsbedingten Abwesenheiten wurden Mitarbeiterinnen und Mitarbeiter durch Vorgesetzte zu ihren Erlebnissen und Umständen befragt. Daneben wurden aus Gesprächen und Flurgesprächen Erkenntnisse über das Privatleben der Beschäftigten gewonnen und ebenfalls aufgezeichnet. Diese Aufzeichnungen umfassten sowohl harmlose Details als auch höchst persönliche Informationen über Familienverhältnisse und religiöse Bekenntnisse. Die Datensätze wurden gespeichert und waren zeitweise für bis zu 50 Führungskräfte einsehbar. Die Daten wurden für zielgerichtete Maßnahmen zur Beschäftigungsgestaltung und -entwicklung einzelner Mitarbeitender genutzt. Die Verarbeitung dieser Daten war ohne ausreichende Rechtsgrundlage. Der Hamburgische Beauftragte für Datenschutz betonte, dass das im Beschäftigungsverhältnis bestehende Machtgefälle es Arbeitnehmern praktisch unmöglich machte, eine freiwillige Einwilligung zu erteilen. H&M erkannte die Verstöße an, kündigte an, betroffene Mitarbeiter zu entschädigen, und arbeitete aktiv an der Aufklärung mit.",
        topics: JSON.stringify(["beschaeftigtendatenschutz", "gesundheitsdaten"]),
        gdpr_articles: JSON.stringify(["5", "6", "9", "88"]),
        status: "final",
    },
    // 1&1 Telecom
    {
        reference: "BFDI-2020-001",
        title: "Bußgeldbescheid — 1&1 Telecom GmbH (unzureichende Authentifizierung)",
        date: "2020-01-09",
        type: "bussgeld",
        entity_name: "1&1 Telecom GmbH",
        fine_amount: 9_550_000,
        summary: "Der BfDI verhängte eine Geldbuße von 9,55 Millionen Euro gegen 1&1 Telecom, weil das Unternehmen im telefonischen Kundendienst keine ausreichenden Authentifizierungsmaßnahmen implementiert hatte, sodass Dritte durch Angabe von Namen und Geburtsdatum eines Kunden Zugang zu dessen Kundendaten erhalten konnten.",
        full_text: "Der Bundesbeauftragte für den Datenschutz und die Informationsfreiheit (BfDI) hat gegen die 1&1 Telecom GmbH eine Geldbuße in Höhe von 9.550.000 Euro verhängt. Der Grund dafür ist eine unzureichende Authentifizierung im Kundendienst. Im Telefon-Kundendienst des Unternehmens war es ausreichend, lediglich den Namen und das Geburtsdatum eines Kunden zu nennen, um Auskunft über Kundendaten zu erhalten. Dies ermöglichte es potenziell jedermann, durch einfach zugängliche persönliche Informationen Zugang zu Kundendaten zu erlangen. Der BfDI wertete dies als einen Verstoß gegen die Pflicht aus Art. 32 DSGVO, geeignete technische und organisatorische Maßnahmen zu ergreifen, um ein dem Risiko angemessenes Schutzniveau zu gewährleisten. 1&1 Telecom GmbH hat zwischenzeitlich ein neues Sicherheitssystem eingeführt. Das Unternehmen hat gegen den Bußgeldbescheid Einspruch eingelegt. Nach Verhandlungen wurde die Geldbuße in einem Urteil des Landgerichts Bonn auf 900.000 Euro reduziert, da das Gericht die Verarbeitung nicht als schwerwiegend einstufte. Der BfDI legte Revision ein.",
        topics: JSON.stringify(["betroffenenrechte"]),
        gdpr_articles: JSON.stringify(["32"]),
        status: "final",
    },
    // Clearview AI — BfDI
    {
        reference: "BFDI-2022-001",
        title: "Anordnung — Clearview AI Inc. (biometrische Daten, unrechtmäßige Verarbeitung)",
        date: "2022-07-04",
        type: "anordnung",
        entity_name: "Clearview AI Inc.",
        fine_amount: 9_625_000,
        summary: "Der BfDI erließ gegen Clearview AI eine Anordnung und verhängte eine Geldbuße von 9,625 Millionen Euro wegen der unrechtmäßigen Verarbeitung biometrischer Daten von deutschen Staatsangehörigen ohne Rechtsgrundlage. Clearview AI betreibt eine Gesichtserkennungsdatenbank aus Milliarden öffentlich zugänglicher Fotos.",
        full_text: "Der Bundesbeauftragte für den Datenschutz und die Informationsfreiheit (BfDI) hat gegen die Clearview AI Inc. eine Geldbuße in Höhe von 9.625.000 Euro verhängt und angeordnet, die unrechtmäßig verarbeiteten Daten von deutschen Staatsbürgern zu löschen. Clearview AI sammelt automatisch Milliarden von Fotos von Menschen aus öffentlich zugänglichen Quellen im Internet und nutzt diese zur Erstellung einer Gesichtserkennungsdatenbank. Diese Datenbank wird hauptsächlich an Strafverfolgungsbehörden vermarktet. Der BfDI stellte fest: (1) Die massenhafte Verarbeitung biometrischer Daten ohne Einwilligung der Betroffenen und ohne andere Rechtsgrundlage gemäß Art. 6 und Art. 9 DSGVO ist rechtswidrig; (2) Clearview AI kam dem Recht auf Auskunft und dem Recht auf Löschung betroffener Personen nicht nach; (3) Clearview AI verfügt über keinen Vertreter in der EU gemäß Art. 27 DSGVO, was eine effektive Aufsicht erschwert. Der BfDI ordnete die Löschung aller von deutschen Staatsangehörigen gespeicherten biometrischen Daten an. Clearview AI räumte seine Zuständigkeit für Deutschland in Frage und kooperierte nicht vollständig mit dem BfDI.",
        topics: JSON.stringify(["datenuebermittlung", "einwilligung", "betroffenenrechte"]),
        gdpr_articles: JSON.stringify(["6", "9", "12", "15", "17", "21", "27"]),
        status: "final",
    },
    // Notebooksbilliger.de — Videoüberwachung
    {
        reference: "LFD-NS-2020-001",
        title: "Bußgeldbescheid — notebooksbilliger.de AG (unzulässige Videoüberwachung)",
        date: "2020-12-22",
        type: "bussgeld",
        entity_name: "notebooksbilliger.de AG",
        fine_amount: 10_400_000,
        summary: "Die Landesbeauftragte für den Datenschutz Niedersachsen verhängte eine Geldbuße von 10,4 Millionen Euro gegen notebooksbilliger.de wegen unzulässiger Videoüberwachung von Mitarbeitern und Kunden über zwei Jahre ohne Rechtsgrundlage.",
        full_text: "Die Landesbeauftragte für den Datenschutz Niedersachsen (LfD Niedersachsen) hat gegen die notebooksbilliger.de AG eine Geldbuße in Höhe von 10,4 Millionen Euro verhängt. Das Unternehmen hat Mitarbeiter und Kunden mindestens zwei Jahre lang mit Kameras überwacht, ohne dafür eine Rechtsgrundlage zu besitzen. Die Überwachung umfasste Verkaufsräume, Lager, Aufenthaltsräume und Arbeitsplätze. Die Überwachungsdaten wurden 60 Tage lang gespeichert, obwohl eine Speicherdauer von wenigen Tagen ausreichend gewesen wäre. Die Behörde stellte fest, dass: (1) Videoüberwachung von Beschäftigten grundsätzlich nur unter strengen Voraussetzungen gemäß § 26 BDSG zulässig ist; (2) eine Aufbewahrungsdauer von 60 Tagen den Grundsatz der Speicherbegrenzung nach Art. 5 Abs. 1 e DSGVO verletzt; (3) das Unternehmen keine ausreichende Interessenabwägung vorgenommen hatte. Das Unternehmen hat zwischenzeitlich die Videoüberwachung auf das zulässige Maß reduziert.",
        topics: JSON.stringify(["videoueberwachung", "beschaeftigtendatenschutz"]),
        gdpr_articles: JSON.stringify(["5", "6", "9"]),
        status: "final",
    },
    // Deutsche Wohnen SE
    {
        reference: "BlnBDI-2019-001",
        title: "Bußgeldbescheid — Deutsche Wohnen SE (fehlende Löschkonzepte)",
        date: "2019-10-30",
        type: "bussgeld",
        entity_name: "Deutsche Wohnen SE",
        fine_amount: 14_500_000,
        summary: "Die Berliner Datenschutzbeauftragte verhängte eine Geldbuße von 14,5 Millionen Euro gegen Deutsche Wohnen SE wegen fehlender Löschkonzepte — das Archivierungssystem für Mieterdaten erlaubte keine Löschung nicht mehr benötigter personenbezogener Daten.",
        full_text: "Die Berliner Beauftragte für Datenschutz und Informationsfreiheit (BlnBDI) hat gegen die Deutsche Wohnen SE eine Geldbuße in Höhe von 14.500.000 Euro verhängt. Das Unternehmen nutzte ein Archivsystem für die Daten von Mietern, das keine Möglichkeit bot, nicht mehr benötigte Daten zu löschen. In dem System waren personenbezogene Daten von Mietern gespeichert, für deren Speicherung es keine Rechtsgrundlage mehr gab. Dies betraf Gehalts-, Steuer-, Sozialversicherungs-, Kontoauszugs-, Selbstauskunfts- und andere Mieterdaten. Die Behörde stellte einen Verstoß gegen den Grundsatz der Speicherbegrenzung (Art. 5 Abs. 1 e DSGVO) fest. Das Kammergericht Berlin hob das Bußgeld später auf prozessualen Gründen auf, ohne die materiell-rechtliche Frage zu entscheiden. Der Fall führte zu wichtigen Diskussionen über die Frage, ob Bußgelder unmittelbar gegen juristische Personen verhängt werden können.",
        topics: JSON.stringify(["betroffenenrechte"]),
        gdpr_articles: JSON.stringify(["5", "25"]),
        status: "final",
    },
];
const insertDecision = db.prepare(`
  INSERT OR IGNORE INTO decisions
    (reference, title, date, type, entity_name, fine_amount, summary, full_text, topics, gdpr_articles, status)
  VALUES
    (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const insertDecisionsAll = db.transaction(() => {
    for (const d of decisions) {
        insertDecision.run(d.reference, d.title, d.date, d.type, d.entity_name, d.fine_amount, d.summary, d.full_text, d.topics, d.gdpr_articles, d.status);
    }
});
insertDecisionsAll();
console.log(`Inserted ${decisions.length} decisions`);
const guidelines = [
    {
        reference: "DSK-DSFA-2017",
        title: "Kurzpapier Nr. 5 — Datenschutz-Folgenabschätzung nach Art. 35 DSGVO",
        date: "2017-04-26",
        type: "kurzpapier",
        summary: "Dieses Kurzpapier der Datenschutzkonferenz (DSK) erläutert die Pflicht zur Datenschutz-Folgenabschätzung (DSFA) gemäß Art. 35 DSGVO. Es erklärt, wann eine DSFA durchzuführen ist, wie der Prozess abläuft und welche Mindestanforderungen an die Dokumentation gestellt werden.",
        full_text: "Art. 35 DSGVO verpflichtet Verantwortliche zur Durchführung einer Datenschutz-Folgenabschätzung (DSFA), wenn eine Verarbeitung voraussichtlich ein hohes Risiko für die Rechte und Freiheiten natürlicher Personen mit sich bringt. Wann ist eine DSFA erforderlich? Eine DSFA ist insbesondere erforderlich bei: (1) Systematischer und umfassender Bewertung persönlicher Aspekte mittels automatisierter Verarbeitung einschließlich Profiling; (2) Umfangreicher Verarbeitung besonderer Kategorien von Daten nach Art. 9 DSGVO; (3) Systematischer Überwachung öffentlich zugänglicher Bereiche in großem Umfang. Die Aufsichtsbehörden haben Positivlisten (Verarbeitungsvorgänge, für die eine DSFA durchzuführen ist) veröffentlicht. Ablauf der DSFA: (1) Beschreibung der Verarbeitungsvorgänge und deren Zwecke; (2) Bewertung der Notwendigkeit und Verhältnismäßigkeit; (3) Bewertung der Risiken für die Rechte und Freiheiten der Betroffenen; (4) Festlegung von Abhilfemaßnahmen. Der Prozess muss dokumentiert werden. Die DSFA ist vor Beginn der Verarbeitung durchzuführen und bei wesentlichen Änderungen zu überprüfen. Falls verbleibende Risiken nicht ausreichend gemindert werden können, muss die Aufsichtsbehörde vorab konsultiert werden (Art. 36 DSGVO).",
        topics: JSON.stringify(["datenschutz_folgenabschaetzung"]),
        language: "de",
    },
    {
        reference: "DSK-BESCHAEFTIGTE-2018",
        title: "Kurzpapier Nr. 14 — Beschäftigtendatenschutz",
        date: "2018-04-17",
        type: "kurzpapier",
        summary: "Dieses Kurzpapier der DSK gibt einen Überblick über die datenschutzrechtlichen Anforderungen im Beschäftigungsverhältnis: Bewerberdaten, Personalakten, Kontrolle und Überwachung sowie besondere Kategorien von Beschäftigtendaten.",
        full_text: "Die Verarbeitung personenbezogener Daten von Beschäftigten ist nach § 26 BDSG und Art. 88 DSGVO zulässig, wenn sie zur Durchführung des Beschäftigungsverhältnisses erforderlich ist. Bewerberdaten: Daten von Bewerbern dürfen nur erhoben werden, soweit dies für die Entscheidung über die Begründung eines Beschäftigungsverhältnisses erforderlich ist. Abgelehnte Bewerbungen sind nach spätestens sechs Monaten zu löschen, sofern keine Aufbewahrungspflicht besteht. Personalakten: Personalakten unterliegen strengen Zugriffsregelungen. Nur Personen, die sie für ihre dienstlichen Aufgaben benötigen, dürfen Zugang erhalten. Daten in Personalakten sind zu löschen, sobald ihre Aufbewahrung nicht mehr erforderlich ist. Kontrolle und Überwachung: Heimliche Überwachungsmaßnahmen sind nur in eng begrenzten Ausnahmefällen zulässig — wenn ein konkreter Verdacht auf eine Straftat oder schwerwiegende Pflichtverletzung besteht und andere Mittel ausgeschöpft sind. Offene Videoüberwachung am Arbeitsplatz ist grundsätzlich nur zulässig, wenn ein legitimes Interesse besteht (Diebstahlschutz etc.) und das Interesse der Arbeitnehmer am Schutz ihrer Persönlichkeit nicht überwiegt. Betriebsrat/Personalrat ist vor der Einführung von Kontroll- und Überwachungsmaßnahmen zu beteiligen. Einwilligung: Im Beschäftigungsverhältnis ist die Einwilligung wegen des bestehenden Abhängigkeitsverhältnisses grundsätzlich nicht als taugliche Rechtsgrundlage anzusehen, außer bei besonderen Umständen.",
        topics: JSON.stringify(["beschaeftigtendatenschutz", "videoueberwachung", "einwilligung"]),
        language: "de",
    },
    {
        reference: "DSK-TOM-2019",
        title: "Orientierungshilfe — Technische und organisatorische Maßnahmen nach Art. 32 DSGVO",
        date: "2019-11-26",
        type: "orientierungshilfe",
        summary: "Diese Orientierungshilfe der DSK beschreibt, welche technischen und organisatorischen Maßnahmen (TOMs) Verantwortliche und Auftragsverarbeiter nach Art. 32 DSGVO umsetzen müssen, um ein dem Risiko angemessenes Schutzniveau zu gewährleisten.",
        full_text: "Art. 32 DSGVO verpflichtet Verantwortliche und Auftragsverarbeiter, geeignete technische und organisatorische Maßnahmen (TOMs) zu ergreifen, um ein dem Risiko angemessenes Schutzniveau zu gewährleisten. Faktoren bei der Auswahl von TOMs: (1) Stand der Technik; (2) Implementierungskosten; (3) Art, Umfang, Umstände und Zwecke der Verarbeitung; (4) Eintrittswahrscheinlichkeit und Schwere des Risikos für die Rechte und Freiheiten natürlicher Personen. Typische TOMs nach Art. 32 Abs. 1 DSGVO: (1) Pseudonymisierung und Verschlüsselung — Daten sollten verschlüsselt übertragen und gespeichert werden; Pseudonymisierung kann das Risiko für Betroffene bei einer Datenpanne erheblich reduzieren; (2) Sicherstellung der Vertraulichkeit — Zugangskontrollen, Berechtigungskonzepte, physische Zutrittssicherung; (3) Integrität — Schutz vor unbefugter Veränderung von Daten, Protokollierung von Zugriffen und Änderungen; (4) Verfügbarkeit — Backup-Konzepte, Notfallpläne, Business Continuity; (5) Belastbarkeit — Systeme müssen auch unter Last funktionsfähig bleiben; (6) Verfahren zur regelmäßigen Überprüfung, Bewertung und Evaluierung — regelmäßige Sicherheitsaudits und Penetrationstests. TOMs müssen dokumentiert werden und regelmäßig überprüft und aktualisiert werden. Der BSI-Grundschutz-Katalog bietet eine praxisnahe Orientierung für die Auswahl geeigneter TOMs.",
        topics: JSON.stringify(["datenschutz_folgenabschaetzung", "auftragsverarbeitung"]),
        language: "de",
    },
    {
        reference: "BFDI-COOKIES-2021",
        title: "Orientierungshilfe — Cookies und Tracking nach TTDSG und DSGVO",
        date: "2021-12-20",
        type: "orientierungshilfe",
        summary: "Diese Orientierungshilfe der DSK erläutert die Anforderungen an Cookies und Tracking-Technologien nach dem Telekommunikation-Telemedien-Datenschutzgesetz (TTDSG) und der DSGVO. Sie geht auf das Einwilligungserfordernis, Ausnahmen sowie Anforderungen an Cookie-Banner ein.",
        full_text: "Mit dem Telekommunikation-Telemedien-Datenschutz-Gesetz (TTDSG), in Kraft getreten am 1. Dezember 2021, wurden die datenschutzrechtlichen Anforderungen für Cookies und Tracking neu geregelt. § 25 TTDSG setzt Art. 5 Abs. 3 der ePrivacy-Richtlinie um und verlangt grundsätzlich eine Einwilligung für das Setzen und Auslesen von Cookies auf Endgeräten der Nutzer. Erfordernis der Einwilligung: Jedes Speichern von Informationen auf dem Endgerät eines Nutzers oder der Zugriff auf dort gespeicherte Informationen erfordert eine vorherige informierte Einwilligung, außer wenn dies unbedingt erforderlich ist, um den vom Nutzer ausdrücklich gewünschten Telemediendienst zu erbringen. Ausnahmen: Technisch notwendige Cookies sind von der Einwilligungspflicht ausgenommen. Dazu gehören Session-Cookies, Warenkorb-Cookies, Login-Cookies und ähnliche Cookies, die für die technische Bereitstellung des Dienstes unbedingt erforderlich sind. Analytik-Cookies und Marketing-Cookies erfordern hingegen eine Einwilligung. Anforderungen an Cookie-Banner: (1) Die Einwilligung muss freiwillig sein — Cookie-Walls, die den Zugang zum Dienst vom Setzen von Cookies abhängig machen, sind grundsätzlich unzulässig; (2) Die Ablehnung muss ebenso einfach sein wie die Zustimmung — ein \"Alle ablehnen\"-Button muss auf der ersten Ebene des Cookie-Banners angeboten werden; (3) Die Einwilligung muss spezifisch für jede Verwendungskategorie eingeholt werden; (4) Die Einwilligung muss jederzeit widerrufbar sein.",
        topics: JSON.stringify(["cookies", "einwilligung"]),
        language: "de",
    },
    {
        reference: "DSK-AVV-2017",
        title: "Kurzpapier Nr. 13 — Auftragsverarbeitung nach Art. 28 DSGVO",
        date: "2017-04-26",
        type: "kurzpapier",
        summary: "Dieses Kurzpapier der DSK erläutert die Anforderungen an die Auftragsverarbeitung nach Art. 28 DSGVO: wann liegt eine Auftragsverarbeitung vor, was muss im Vertrag geregelt werden und welche Pflichten haben Auftraggeber und Auftragsverarbeiter.",
        full_text: "Art. 28 DSGVO regelt die Auftragsverarbeitung — die Verarbeitung personenbezogener Daten durch einen Dienstleister im Auftrag des Verantwortlichen. Wann liegt Auftragsverarbeitung vor? Auftragsverarbeitung liegt vor, wenn ein Dienstleister Daten ausschließlich nach Weisung des Auftraggebers verarbeitet und keine eigenen Entscheidungsbefugnisse bezüglich Zweck und Mittel der Verarbeitung hat. Beispiele: Cloud-Speicherdienstleistungen, Lohnabrechnung durch externe Dienstleister, IT-Hosting, externe Datenverarbeitung. Anforderungen an den Auftragsverarbeitungsvertrag (AVV): Der AVV muss schriftlich oder in einem elektronischen Format abgeschlossen werden und folgendes regeln: Gegenstand und Dauer der Verarbeitung; Art und Zweck der Verarbeitung; Art der personenbezogenen Daten und Kategorien von betroffenen Personen; Pflichten und Rechte des Verantwortlichen. Wesentliche Pflichten des Auftragsverarbeiters: Verarbeitung nur nach dokumentierten Weisungen; Gewährleistung der Vertraulichkeit; Umsetzung geeigneter TOMs nach Art. 32 DSGVO; Einschaltung von Unterauftragsverarbeitern nur mit Genehmigung; Unterstützung bei der Wahrung der Betroffenenrechte; Löschung oder Rückgabe der Daten nach Vertragsende. EU-Standardvertragsklauseln: Bei Auftragsverarbeitung in Drittländern müssen geeignete Garantien nach Art. 44 ff. DSGVO vorliegen — in der Regel durch EU-Standardvertragsklauseln (SCC).",
        topics: JSON.stringify(["auftragsverarbeitung", "datenuebermittlung"]),
        language: "de",
    },
];
const insertGuideline = db.prepare(`
  INSERT INTO guidelines (reference, title, date, type, summary, full_text, topics, language)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);
const insertGuidelinesAll = db.transaction(() => {
    for (const g of guidelines) {
        insertGuideline.run(g.reference, g.title, g.date, g.type, g.summary, g.full_text, g.topics, g.language);
    }
});
insertGuidelinesAll();
console.log(`Inserted ${guidelines.length} guidelines`);
// --- Summary -----------------------------------------------------------------
const decisionCount = db.prepare("SELECT count(*) as cnt FROM decisions").get().cnt;
const guidelineCount = db.prepare("SELECT count(*) as cnt FROM guidelines").get().cnt;
const topicCount = db.prepare("SELECT count(*) as cnt FROM topics").get().cnt;
const decisionFtsCount = db.prepare("SELECT count(*) as cnt FROM decisions_fts").get().cnt;
const guidelineFtsCount = db.prepare("SELECT count(*) as cnt FROM guidelines_fts").get().cnt;
console.log(`\nDatabase summary:`);
console.log(`  Topics:         ${topicCount}`);
console.log(`  Decisions:      ${decisionCount} (FTS entries: ${decisionFtsCount})`);
console.log(`  Guidelines:     ${guidelineCount} (FTS entries: ${guidelineFtsCount})`);
console.log(`\nDone. Database ready at ${DB_PATH}`);
db.close();
