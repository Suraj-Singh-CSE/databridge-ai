"""A small, realistic sandbox dataset for the SQL agent's tests."""

from app.sql.contract import Contract, FieldInfo, SandboxData, StagedRow

FIELDS = (
    FieldInfo("customer_id", "Customer id assigned by DataBridge", generated=True),
    FieldInfo("full_name", "Customer's full name"),
    FieldInfo("phone", "Mobile number in E.164"),
    FieldInfo("email", "Email address, lower case"),
    FieldInfo("city", "City"),
)
CONTRACT = Contract(FIELDS)

# Real-looking values: the privacy tests assert none of them reaches a prompt.
SECRET_VALUES = ("Asha Rao", "+919820012345", "asha.rao@example.com", "Pune", "Vikram Shah")


def sample_data() -> SandboxData:
    """Three customers (two approved), five records."""
    staged = (
        StagedRow(
            "r1",
            "crm_customers",
            "CRM-1",
            {"full_name": "Asha Rao", "phone": "+919820012345", "email": None, "city": "Pune"},
        ),
        StagedRow(
            "r2",
            "billing_export",
            "#2",
            {
                "full_name": "Asha  Rao",
                "phone": None,
                "email": "asha.rao@example.com",
                "city": "Pune",
            },
        ),
        StagedRow(
            "r3",
            "crm_customers",
            "CRM-3",
            {"full_name": "Vikram Shah", "phone": "+919811122233", "email": None, "city": None},
        ),
        StagedRow("r4", "support", "S-4", {"full_name": "Meera Iyer", "phone": None}),
        StagedRow("r5", "support", "S-5", {"full_name": "Meera Iyer", "city": "Chennai"}),
    )
    golden = {
        "C1": {
            "customer_id": "C1",
            "full_name": "Asha Rao",
            "phone": "+919820012345",
            "email": "asha.rao@example.com",
            "city": "Pune",
        },
        "C2": {
            "customer_id": "C2",
            "full_name": "Vikram Shah",
            "phone": "+919811122233",
            "email": None,
            "city": None,
        },
        "C3": {
            "customer_id": "C3",
            "full_name": "Meera Iyer",
            "phone": None,
            "email": None,
            "city": "Chennai",
        },
    }
    return SandboxData(
        contract=CONTRACT,
        staged=staged,
        members=(("C1", "r1"), ("C1", "r2"), ("C2", "r3"), ("C3", "r4"), ("C3", "r5")),
        golden=golden,
        approvals={"C1": True, "C2": True, "C3": False},
    )
