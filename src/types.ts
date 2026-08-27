export type Destination = {
  id: string
  name: string
  address: string | null
  contact_name: string | null
  active: boolean
  created_at: string
}

export type Shipment = {
  id: string
  shipped_at: string
  vehicle_no: string | null
  note: string | null
  destinations: { name: string } | null
  shipment_items: { lot_number: string }[]
}
