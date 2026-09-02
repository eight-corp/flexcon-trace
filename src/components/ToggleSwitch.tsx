type Props = {
  checked: boolean
  label: string
  onChange: () => void
}

export function ToggleSwitch({ checked, label, onChange }: Props) {
  return (
    <button
      className="toggle-switch"
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      title={label}
      onClick={onChange}
    >
      <span />
    </button>
  )
}
