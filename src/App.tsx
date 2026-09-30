import { useState, useRef } from 'react';

// Calcolo del Checksum: complemento a 1 della somma modulo 256
function calcolaChecksum(bytes: number[]): number {
  const sum = bytes.reduce((a, b) => a + b, 0);
  return (255 - (sum % 256)) & 0xFF;
}

export default function App() {
  // 1. STATO CONFIGURAZIONE DI CONNESIONE
  const [baudRate, setBaudRate] = useState<number>(1000000);
  const [servoId, setServoId] = useState<number>(1);
  const [statoConnessione, setStatoConnessione] = useState<string>("Disconnesso");
  const [isConnesso, setIsConnesso] = useState<boolean>(false);

  // 2. STATO TELEMETRIA E COMANDI
  const [statoServo, setStatoServo] = useState<string>("Non interrogato");
  const [posizioneTarget, setPosizioneTarget] = useState<number>(2048);
  const [posizioneLetta, setPosizioneLetta] = useState<number | null>(null);
  const [temperatura, setTemperatura] = useState<number | null>(null); // State per la temperatura
  const [logConsole, setLogConsole] = useState<string[]>([]);

  // Riferimenti Web Serial API
  const portRef = useRef<any>(null);
  const writerRef = useRef<any>(null);
  const readerRef = useRef<any>(null);

  const addLog = (msg: string) => {
    setLogConsole((prev) => [
      `[${new Date().toLocaleTimeString()}] ${msg}`,
      ...prev.slice(0, 49),
    ]);
  };

  // CONNESIONE ALLA PORTA SERIALE
  async function connetti() {
    try {
      if (!('serial' in navigator)) {
        alert("Web Serial API non supportata in questo browser. Usa Chrome, Edge o Firefox!");
        return;
      }

      const port = await (navigator as any).serial.requestPort();
      await port.open({ baudRate: Number(baudRate) });

      portRef.current = port;
      writerRef.current = port.writable.getWriter();
      readerRef.current = port.readable.getReader();

      setIsConnesso(true);
      setStatoConnessione(`Connesso a ${baudRate} baud`);
      addLog(`Porta seriale aperta a ${baudRate} baud.`);
    } catch (err: any) {
      console.error("Errore di connessione:", err);
      setStatoConnessione("Errore o selezione annullata");
      addLog(`Errore: ${err.message || err}`);
    }
  }

  // DISCONNESIONE ORDINATA (Rilascio Lock)
  async function disconnetti() {
    try {
      if (readerRef.current) {
        await readerRef.current.cancel();
        readerRef.current.releaseLock();
        readerRef.current = null;
      }
      if (writerRef.current) {
        writerRef.current.releaseLock();
        writerRef.current = null;
      }
      if (portRef.current) {
        await portRef.current.close();
        portRef.current = null;
      }
      setIsConnesso(false);
      setStatoConnessione("Disconnesso");
      addLog("Porta chiusa e lock rilasciato correttamente.");
    } catch (err: any) {
      addLog(`Errore disconnessione: ${err.message || err}`);
    }
  }

  // INVIO PACCHETTO BINARIO
  async function inviaPacchetto(pacchetto: number[]) {
    if (!writerRef.current) return;
    const data = new Uint8Array(pacchetto);
    await writerRef.current.write(data);
    const hex = Array.from(data)
      .map((b) => b.toString(16).toUpperCase().padStart(2, '0'))
      .join(' ');
    addLog(`TX ➔ ${hex}`);
  }

  // LETTURA RISPOSTA
  async function leggiRisposta(): Promise<number[] | null> {
    if (!readerRef.current) return null;
    try {
      const { value, done } = await readerRef.current.read();
      if (done || !value) return null;
      const bytes = Array.from(value as Uint8Array);
      const hex = bytes
        .map((b) => b.toString(16).toUpperCase().padStart(2, '0'))
        .join(' ');
      addLog(`RX ⬅ ${hex}`);
      return bytes;
    } catch (err: any) {
      addLog(`Errore lettura: ${err.message || err}`);
      return null;
    }
  }

  // COMANDO 1: PING (Istruzione 0x01)
  async function inviaPing() {
    const id = Number(servoId);
    const len = 0x02;
    const istr = 0x01;
    const chk = calcolaChecksum([id, len, istr]);
    const pacchetto = [0xFF, 0xFF, id, len, istr, chk];

    await inviaPacchetto(pacchetto);
    const risp = await leggiRisposta();

    if (risp && risp.length >= 5) {
      const statusByte = risp[4];
      if (statusByte === 0) {
        setStatoServo(`Servo ID ${id} Online (Stato 0x00 - OK)`);
      } else {
        setStatoServo(`Servo ID ${id} Allarme! (Byte Stato 0x${statusByte.toString(16)})`);
      }
    }
  }

  // COMANDO 2: SCRITTURA POSIZIONE TARGET (Registro 42 / 0x2A)
  async function impostaPosizione() {
    const id = Number(servoId);
    const reg = 0x2A; // Registro 42
    const pos = Number(posizioneTarget);
    const lowByte = pos & 0xFF;         // Little-Endian
    const highByte = (pos >> 8) & 0xFF;
    const len = 0x05;
    const istr = 0x03; // Scrittura
    const chk = calcolaChecksum([id, len, istr, reg, lowByte, highByte]);

    const pacchetto = [0xFF, 0xFF, id, len, istr, reg, lowByte, highByte, chk];
    await inviaPacchetto(pacchetto);
    await leggiRisposta();
  }

  // COMANDO 3: LETTURA POSIZIONE CORRENTE (Registro 56 / 0x38)
  async function leggiPosizione() {
    const id = Number(servoId);
    const reg = 0x38; // Registro 56
    const numByte = 0x02;
    const len = 0x04;
    const istr = 0x02; // Lettura
    const chk = calcolaChecksum([id, len, istr, reg, numByte]);

    const pacchetto = [0xFF, 0xFF, id, len, istr, reg, numByte, chk];
    await inviaPacchetto(pacchetto);
    const risp = await leggiRisposta();

    if (risp && risp.length >= 7) {
      const low = risp[5];
      const high = risp[6];
      const posLetta = low + (high << 8); // Ricostruzione Little-Endian
      setPosizioneLetta(posLetta);
      addLog(`Posizione attuale dal Servo ID ${id}: ${posLetta}`);
    }
  }

  // COMANDO 4: LETTURA TEMPERATURA (Registro 43 / 0x2B - 1 Byte in °C)
  async function leggiTemperatura() {
    const id = Number(servoId);
    const reg = 0x2B; // Registro 43 (Temperatura)
    const numByte = 0x01; // 1 solo byte
    const len = 0x04;
    const istr = 0x02; // Lettura
    const chk = calcolaChecksum([id, len, istr, reg, numByte]);

    const pacchetto = [0xFF, 0xFF, id, len, istr, reg, numByte, chk];
    await inviaPacchetto(pacchetto);
    const risp = await leggiRisposta();

    if (risp && risp.length >= 6) {
      // Risposta: FF FF ID LEN STATUS TEMP_BYTE CHK
      const tempVal = risp[5];
      setTemperatura(tempVal);
      addLog(`Temperatura del Servo ID ${id}: ${tempVal}°C`);
    }
  }

  return (
    <div style={{ padding: 24, fontFamily: 'sans-serif', maxWidth: 800, margin: '0 auto' }}>
      <h2>⚙️ Controllo Servomotore - Web Serial API</h2>

      {/* 1. SEZIONE CONFIGURAZIONE */}
      <div style={{ background: '#f2f4f8', padding: 16, borderRadius: 8, marginBottom: 20 }}>
        <h3 style={{ marginTop: 0 }}>1. Configurazione Connessione</h3>
        <div style={{ display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap' }}>
          <div>
            <label style={{ fontWeight: 'bold', display: 'block', marginBottom: 4 }}>
              Velocità (Baud Rate):
            </label>
            <select
              value={baudRate}
              onChange={(e) => setBaudRate(Number(e.target.value))}
              disabled={isConnesso}
              style={{ padding: '6px 12px', fontSize: 14 }}
            >
              <option value={1000000}>1.000.000 baud (1 Mbit/s - Standard Corso)</option>
              <option value={115200}>115.200 baud</option>
              <option value={57600}>57.600 baud</option>
              <option value={9600}>9.600 baud</option>
            </select>
          </div>

          <div>
            <label style={{ fontWeight: 'bold', display: 'block', marginBottom: 4 }}>
              ID Servomotore (1..253):
            </label>
            <input
              type="number"
              min={1}
              max={254}
              value={servoId}
              onChange={(e) => setServoId(Number(e.target.value))}
              style={{ padding: '6px 12px', fontSize: 14, width: 90 }}
            />
          </div>

          <div style={{ marginTop: 20 }}>
            {!isConnesso ? (
              <button 
                onClick={connetti} 
                style={{ padding: '8px 16px', background: '#28a745', color: '#fff', border: 'none', borderRadius: 4, cursor: 'pointer', fontWeight: 'bold' }}
              >
                🔌 Connetti
              </button>
            ) : (
              <button 
                onClick={disconnetti} 
                style={{ padding: '8px 16px', background: '#dc3545', color: '#fff', border: 'none', borderRadius: 4, cursor: 'pointer', fontWeight: 'bold' }}
              >
                ❌ Disconnetti
              </button>
            )}
          </div>
        </div>
        <p style={{ marginTop: 12, marginBottom: 0 }}>
          Stato Porta: <strong>{statoConnessione}</strong>
        </p>
      </div>

      {/* 2. SEZIONE PANNELLO COMANDI */}
      <div style={{ background: '#fff', border: '1px solid #ddd', padding: 16, borderRadius: 8, marginBottom: 20 }}>
        <h3 style={{ marginTop: 0 }}>2. Pannello Comandi per Servo ID: {servoId}</h3>

        {/* PING */}
        <div style={{ marginBottom: 16 }}>
          <button onClick={inviaPing} disabled={!isConnesso} style={{ padding: '8px 16px', marginRight: 12, cursor: 'pointer' }}>
            📡 Invia Ping (Istruzione 0x01)
          </button>
          <span>Stato Motore: <strong>{statoServo}</strong></span>
        </div>

        <hr style={{ margin: '16px 0', border: 'none', borderTop: '1px solid #eee' }} />

        {/* SLIDER POSIZIONE TARGET */}
        <div style={{ marginBottom: 16 }}>
          <label style={{ fontWeight: 'bold', display: 'block', marginBottom: 8 }}>
            Imposta Posizione Target (0 - 4095): {posizioneTarget}
          </label>
          <input
            type="range"
            min={0}
            max={4095}
            value={posizioneTarget}
            onChange={(e) => setPosizioneTarget(Number(e.target.value))}
            style={{ width: '70%', marginRight: 12, verticalAlign: 'middle' }}
          />
          <button onClick={impostaPosizione} disabled={!isConnesso} style={{ padding: '6px 14px', cursor: 'pointer' }}>
            🎯 Muovi Motore
          </button>
        </div>

        <hr style={{ margin: '16px 0', border: 'none', borderTop: '1px solid #eee' }} />

        {/* LETTURA POSIZIONE REALE */}
        <div style={{ marginBottom: 16 }}>
          <button onClick={leggiPosizione} disabled={!isConnesso} style={{ padding: '8px 16px', marginRight: 12, cursor: 'pointer' }}>
            📖 Leggi Posizione Corrente (Registro 56)
          </button>
          {posizioneLetta !== null && (
            <span>Posizione Rilevata: <strong>{posizioneLetta}</strong> / 4095</span>
          )}
        </div>

        <hr style={{ margin: '16px 0', border: 'none', borderTop: '1px solid #eee' }} />

        {/* NUOVO: LETTURA TEMPERATURA */}
        <div>
          <button onClick={leggiTemperatura} disabled={!isConnesso} style={{ padding: '8px 16px', marginRight: 12, cursor: 'pointer' }}>
            🌡️ Leggi Temperatura (Registro 43)
          </button>
          {temperatura !== null && (
            <span style={{ color: temperatura > 50 ? 'red' : 'inherit', fontWeight: 'bold' }}>
              Temperatura Interna: {temperatura} °C {temperatura > 50 ? '⚠️ (Attenzione surriscaldamento!)' : '✅'}
            </span>
          )}
        </div>
      </div>

      {/* 3. LOG CONSOLE */}
      <div style={{ background: '#1e1e1e', color: '#00ff66', padding: 12, borderRadius: 8, fontFamily: 'monospace', fontSize: 13, height: 160, overflowY: 'auto' }}>
        <div style={{ borderBottom: '1px solid #444', paddingBottom: 4, marginBottom: 8, color: '#aaa' }}>
          Console Log Pacchetti Binari (TX / RX in Esadecimale)
        </div>
        {logConsole.length === 0 ? (
          <div>In attesa di dati dalla porta seriale...</div>
        ) : (
          logConsole.map((line, idx) => <div key={idx}>{line}</div>)
        )}
      </div>
    </div>
  );
}