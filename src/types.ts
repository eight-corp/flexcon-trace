export type Destination = {
  id: string
  name: string
  address: string | null
  contact_name: string | null
  active: boolean
  created_at: string
}

export type Worker = {
  worker_id: string
  worker_name: string
  role: 'admin' | 'operator' | 'viewer'
  display_order: number
  active: boolean
  note: string
}

export type Shipment = {
  id: string
  shipped_at: string
  vehicle_no: string | null
  note: string | null
  flexcon_destinations: { name: string } | null
  flexcon_shipment_items: { lot_number: string }[]
  workers: { worker_name: string } | null
}
