import { createRoot } from 'react-dom/client'
import { Player } from '../src/Player'
import { TabPlayer } from '../src/TabPlayer'
import type { Room } from '../src/model'
import '../src/style.css'

const room: Room = {
  id: 'room', title: 'Тестовый кинозал', is_locked: false, host: 'host', invite: 'invite', mode: 'video', stream_id: 'stream',
  source: 'data:video/mp4;base64,', paused: true, position: 0, version: 1,
  changed_at: new Date().toISOString(), touched_at: new Date().toISOString(),
}
const report = (message: string) => { throw new Error(message) }
createRoot(document.getElementById('root')!).render(
  location.search === '?tab'
    ? <TabPlayer room={{ ...room, mode: 'tab' }} user="host" capture={null} quality="balanced" viewers={[]} report={report} />
    : <Player room={room} offset={{ current: 0 }} disabled={false} command={async () => {}} report={report} />,
)
