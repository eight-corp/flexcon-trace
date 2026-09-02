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
  driver_name: string | null
  vehicle_no: string | null
  active: boolean
  created_at: string
  updated_at: string
}

export type Shipment = {
  id: string
  destination_id: string
  transport_profile_id: string | null
  shipped_at: string
  carrier_name: string | null
  driver_name: string | null
  vehicle_no: string | null
  note: string | null
  flexcon_destinations: { name: string } | null
  flexcon_shipment_items: { lot_number: string }[]
  workers: { worker_name: string } | null
}

export type AuthorizationRecord = {
  id: string
  authorization_no: string
  full_name: string
  seed_purchase_slip: boolean
  farming_plan: boolean
  address: string | null
  prefecture: string | null
  municipality: string | null
  phone: string | null
  crop_type: string | null
  feed_rice_variety: string | null
  notes: string | null
  created_at: string
  updated_at: string
}
