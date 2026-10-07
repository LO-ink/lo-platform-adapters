# `@lo-ink/adapter-webapp-compat`

Shared wire translation used by the LO and Telegram adapters. Applications
should install a host adapter instead of importing this package directly.

Sensor starts return `false` without acquiring a manager that is already running or has a pending acquisition, including an acquisition by another SDK client. Pending starts release their own activity when cancelled; a late successful callback stops that activity unless a newer request owns the same manager. Callers remain responsible for stopping sensors after a successful completed start when their feature unmounts. Sensor failure events expose a normalized `reason`.

Canonical SDK content insets are additional to system safe-area insets. Telegram
already provides that convention. LO legacy WebApp hosts provide the full content
obstruction instead; their adapter opts into `contentSafeAreaIncludesSystem` and
subtracts the system inset, clamping at zero. Both legacy inset events refresh the
derived value. The Telegram adapter recognizes the LO compatibility alias only
when `scope.LO.WebApp` and `scope.Telegram.WebApp` are the same object; a real
Telegram host keeps its original additive values.
