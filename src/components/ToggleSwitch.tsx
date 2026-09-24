type Props = {
  checked: boolean
  label: string
  onChange: () => void
  disabled?: boolean
}

export function ToggleSwitch({ checked, label, onChange, disabled = false }: Props) {
  return (
    <button
      className="toggle-switch"
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      title={label}
      onClick={onChange}
      disabled={disabled}
    >
      <span />
    </button>
  )
}
