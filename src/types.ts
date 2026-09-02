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

export type TransportProfile = {
  id: string
  company_name: string
  driver_name: string
  vehicle_no: string
  active: boolean
  created_at: string
  updated_at: string
}

export type Shipment = {
  id: string
  shipped_at: string
  contact_name: string | null
  carrier_name: string | null
  driver_name: string | null
  vehicle_no: string | null
  note: string | null
  flexcon_destinations: { name: string } | null
  flexcon_shipment_items: { lot_number: string }[]
  workers: { worker_name: string } | null
}
