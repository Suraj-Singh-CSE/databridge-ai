"""FastAPI dependencies shared by routes."""

from fastapi import Request

from app.services import Services


def get_services(request: Request) -> Services:
    services: Services = request.app.state.services
    return services
