import http from 'k6/http';
import { check } from 'k6';

export const options = {
  scenarios: {
    rush: { executor: 'constant-arrival-rate', rate: 500, timeUnit: '1s', duration: '30s', preAllocatedVUs: 200 }
  }
};
const baseUrl = __ENV.BASE_URL || 'http://localhost:3000';

export default function () {
  const seatId = Math.floor(Math.random() * 50) + 1;
  const hold = http.post(`${baseUrl}/events/1/holds`, JSON.stringify({ seatIds: [seatId] }), { headers: { 'Content-Type': 'application/json', 'x-user-id': `${__VU}` } });
  check(hold, { 'hold is accepted or conflicts': (response) => response.status === 200 || response.status === 409 });
}
