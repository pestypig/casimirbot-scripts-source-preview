"""Additive infrastructure seams; not linked into any consumed P8Q entry."""
import subprocess


def isolated_runner(runner):
    """Preserve the caller's exact request; hide/isolate only its Windows console.

    No default live runner: tests explicitly inject an inert callable. This is
    not SDK authentication, retry, transport or a cloud-execution grant.
    """
    def call(argv, **kwargs):
        if 'creationflags' in kwargs:
            raise ValueError('existing creation policy must be reviewed explicitly')
        return runner(argv, **kwargs, creationflags=subprocess.CREATE_NO_WINDOW)
    return call


def cleanup_once(port):
    """Attempt STOP once, then observe shutdown even when its reply is uncertain.

    The submitted/failed transaction stays failed. Independent observation
    establishes resource state; it never retroactively makes STOP successful.
    Identity admission remains the port's responsibility, not a bypass here.
    """
    stop_error = shutdown_error = shutdown = None
    try:
        port.stop_once()
    except Exception as error:
        stop_error = type(error).__name__ + ':' + str(error)[:160]
    try:
        shutdown = port.observe_shutdown()
    except Exception as error:
        shutdown_error = type(error).__name__ + ':' + str(error)[:160]
    return {'stop_error': stop_error, 'shutdown_error': shutdown_error,
            'shutdown': shutdown, 'transaction_passed': stop_error is None
            and shutdown_error is None and shutdown is not None}
