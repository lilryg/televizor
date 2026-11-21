import { useEffect, useRef, useState } from 'react'
import { Bell, Cherry, Citrus, Diamond, Grape } from 'lucide-react'
import { errorText, slots } from './api'
import { Button } from './ui/button'

const desktopQuery = '(min-width: 900px) and (hover: hover) and (pointer: fine)'
const stakes = [1, 10, 100] as const
const symbols = [
  { name: 'Вишня', icon: Cherry, color: '#ff7892', multiplier: 8 },
  { name: 'Лимон', icon: Citrus, color: '#f3cc63', multiplier: 10 },
  { name: 'Виноград', icon: Grape, color: '#b39cff', multiplier: 12 },
  { name: 'Колокол', icon: Bell, color: '#ffac6d', multiplier: 16 },
  { name: 'Бриллиант', icon: Diamond, color: '#79ded2', multiplier: 24 },
  { name: 'Семёрка', icon: null, color: '#ff829e', multiplier: 48 },
]
const number = new Intl.NumberFormat('ru-RU')

function Symbol({ value }: { value: number }) {
  const item = symbols[value]
  const Icon = item.icon
  return <span className="slot-symbol" style={{ color: item.color }} aria-label={item.name} role="img">
    {Icon ? <Icon size={23} aria-hidden="true" /> : <span aria-hidden="true">7</span>}
  </span>
}

export function SlotPanel({ room, visit }: { room: string; visit: string }) {
  const [desktop, setDesktop] = useState(() => matchMedia(desktopQuery).matches)
  const [balance, setBalance] = useState<number>()
  const [stake, setStake] = useState<(typeof stakes)[number]>(10)
  const [reels, setReels] = useState([0, 3, 5])
  const [message, setMessage] = useState('')
  const [spinning, setSpinning] = useState(false)
  const request = useRef<{ id: string; stake: number }>(undefined)
  const running = useRef(false)

  useEffect(() => {
    const media = matchMedia(desktopQuery)
    const changed = () => setDesktop(media.matches)
    media.addEventListener('change', changed)
    return () => media.removeEventListener('change', changed)
  }, [])

  useEffect(() => {
    if (!desktop) return
    let active = true
    void slots(room, visit).then((result) => {
      if (active) setBalance(result.balance)
    }).catch((error) => {
      if (active) setMessage(errorText(error))
    })
    return () => { active = false }
  }, [desktop, room, visit])

  async function spin() {
    if (running.current) return
    running.current = true
    setSpinning(true)
    setMessage('')
    const current = request.current ??= { id: crypto.randomUUID(), stake }
    try {
      const [result] = await Promise.all([
        slots(room, visit, current.stake, current.id),
        new Promise((resolve) => setTimeout(resolve, 360)),
      ])
      request.current = undefined
      setReels(result.reels)
      setBalance(result.balance)
      setMessage(result.payout > current.stake ? `Выигрыш +${number.format(result.payout - current.stake)}`
        : result.payout === current.stake ? 'Ставка возвращена' : `Проигрыш −${current.stake}`)
    } catch (error) {
      const message = errorText(error)
      if (!message.startsWith('Нет связи')) request.current = undefined
      setMessage(message)
    } finally {
      running.current = false
      setSpinning(false)
    }
  }

  if (!desktop) return null
  return <aside className="panel slot-panel" aria-label="Слоты">
    <h2>Слоты</h2>
    <div className="slot-balance"><strong>{balance === undefined ? '…' : number.format(balance)}</strong> тугриков</div>
    <div className="slot-reels" data-spinning={spinning || undefined}>
      {reels.map((symbol, index) => <Symbol key={index} value={symbol} />)}
    </div>
    <fieldset className="slot-stakes" disabled={spinning || !!request.current}>
      <legend>Ставка</legend>
      {stakes.map((value) => <Button key={value} type="button" variant="secondary" aria-pressed={stake === value}
        onClick={() => setStake(value)}>{value}</Button>)}
    </fieldset>
    <Button type="button" disabled={spinning || (balance !== undefined && stake > balance)} onClick={() => void spin()}>
      {spinning ? 'Крутим…' : request.current ? 'Повторить' : 'Крутить'}
    </Button>
    <p className="slot-message" role="status">{message}</p>
    <details className="slot-rules">
      <summary>Правила и выплаты</summary>
      <p>Три независимых барабана, по шесть равновероятных символов. Два одинаковых символа возвращают ставку.</p>
      <ul>{symbols.map((item, index) => <li key={item.name}><Symbol value={index} /> <span>{item.name} × 3</span>
        <strong>×{item.multiplier}</strong></li>)}</ul>
      <p>Средний возврат — 96,3%. Тугрики действуют только в этой комнате.</p>
    </details>
  </aside>
}
