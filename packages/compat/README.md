# `@lo/adapter-webapp-compat`

Shared wire translation used by the LO and Telegram adapters. Applications
should install a host adapter instead of importing this package directly.

Sensor starts return `false` without acquiring a manager that is already running. Pending starts release their own activity when cancelled; a late successful callback stops that activity unless a newer request owns the same manager. Callers remain responsible for stopping sensors after a successful completed start when their feature unmounts. Sensor failure events expose a normalized `reason`.
