"""Python client for one Restaurant Sim agent seat."""

from .client import (
    APIError,
    Client,
    ClientError,
    ConfigurationError,
    ProtocolError,
    TransportError,
    WaitTimeout,
)

__all__ = [
    "APIError",
    "Client",
    "ClientError",
    "ConfigurationError",
    "ProtocolError",
    "TransportError",
    "WaitTimeout",
]
