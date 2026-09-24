import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';

type Seat = { id: number; label: string; status: 'available' | 'held' | 'booked' };
const API = 'http://localhost:3001';

function App() {
  const [seats, setSeats] = useState<Seat[]>([]);
  const [selected, setSelected] = useState<Seat | null>(null);
  const [status, setStatus] = useState('Choose a seat to begin');
  const [email, setEmail] = useState('guest@example.com');

  async function loadSeats() {
    const response = await fetch(`${API}/events/1/seats`);
    const data = await response.json();
    setSeats(data.seats);
  }

  useEffect(() => { void loadSeats(); }, []);

  async function bookSeat() {
    if (!selected) return;
    setStatus('Securing your seat...');
    const holdResponse = await fetch(`${API}/events/1/holds`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-user-id': '1' }, body: JSON.stringify({ seatIds: [selected.id] }) });
    if (!holdResponse.ok) { setStatus('That seat was just taken. Pick another.'); await loadSeats(); return; }
    const hold = await holdResponse.json();
    const bookingResponse = await fetch(`${API}/bookings`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-user-id': '1', 'Idempotency-Key': crypto.randomUUID() }, body: JSON.stringify({ eventId: 1, seatIds: [selected.id], holdId: hold.holdId, email }) });
    if (bookingResponse.ok) { setStatus(`${selected.label} is booked. Enjoy the show.`); setSelected(null); await loadSeats(); }
    else setStatus('The hold expired or another booking won the race.');
  }

  return <main>
    <header><div className="eyebrow">LIVE BOOKING / 001</div><h1>The Midnight<br /><em>Assembly</em></h1><p className="lede">A close-up concert in a room built for listening.</p><div className="event-meta"><span>FRI 24 OCT 2026</span><span>THE ORBITAL / 8:00 PM</span></div></header>
    <section className="booking-panel"><div className="panel-head"><div><span className="eyebrow">SELECT YOUR PLACE</span><h2>Studio floor plan</h2></div><span className="status">{status}</span></div><div className="stage">STAGE</div><div className="seat-grid">{seats.map((seat) => <button key={seat.id} className={`seat ${seat.status} ${selected?.id === seat.id ? 'selected' : ''}`} disabled={seat.status !== 'available'} onClick={() => setSelected(seat)}>{seat.label}</button>)}</div><div className="legend"><span><i className="available" /> Available</span><span><i className="selected-dot" /> Selected</span><span><i className="booked" /> Booked</span></div><div className="checkout"><label>Email for confirmation<input value={email} onChange={(event) => setEmail(event.target.value)} type="email" /></label><button className="reserve" disabled={!selected || !email} onClick={() => void bookSeat()}>Reserve {selected?.label ?? 'seat'} <span>↗</span></button></div></section>
  </main>;
}

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
