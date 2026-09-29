import type { KeyboardEvent } from 'react'

type Field = HTMLInputElement | HTMLSelectElement

function fieldsInCell(cell: HTMLTableCellElement): Field[] {
  return Array.from(cell.querySelectorAll<Field>('input[type="text"], input:not([type]), select'))
    .filter((field) => !field.disabled && !(field instanceof HTMLInputElement && field.readOnly))
}

export function navigateInspectionField(event: KeyboardEvent<HTMLTableElement>) {
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.nativeEvent.isComposing) return
  if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) return
  const source = event.target
  if (!(source instanceof HTMLInputElement || source instanceof HTMLSelectElement)) return
  const cell = source.closest('td')
  const row = cell?.parentElement
  if (!cell || !(row instanceof HTMLTableRowElement) || !(row.parentElement instanceof HTMLTableSectionElement) || row.parentElement.tagName !== 'TBODY') return
  if (!fieldsInCell(cell).includes(source)) return

  if (source instanceof HTMLInputElement) {
    const atStart = source.selectionStart === 0 && source.selectionEnd === 0
    const atEnd = source.selectionStart === source.value.length && source.selectionEnd === source.value.length
    if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') {
      if (!atStart) return
    } else if (!atEnd) return
  }

  // Boundary arrows never change a number or a selected option, even at the table edge.
  event.preventDefault()
  let destination: Field | undefined
  if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
    const rows = Array.from(row.parentElement.rows)
    const nextRow = rows[rows.indexOf(row) + (event.key === 'ArrowUp' ? -1 : 1)]
    const nextCell = nextRow?.cells[cell.cellIndex]
    if (nextCell) destination = fieldsInCell(nextCell)[fieldsInCell(cell).indexOf(source)]
  } else {
    const rowFields = Array.from(row.cells).flatMap(fieldsInCell)
    destination = rowFields[rowFields.indexOf(source) + (event.key === 'ArrowLeft' ? -1 : 1)]
  }
  if (!destination) return
  destination.focus()
  if (destination instanceof HTMLInputElement) {
    const position = event.key === 'ArrowLeft' || event.key === 'ArrowDown' ? destination.value.length : 0
    destination.setSelectionRange(position, position)
  }
}
