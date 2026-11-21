"""Internal job routes: service token, validation, 202 on enqueue/cancel, 503 when Redis is down."""

from fastapi.testclient import TestClient

from tests.conftest import AUTH, FakeJobQueue

JOBS = "/internal/v1/jobs"
JOB_ID = "0123456789abcdef01234567"
PROJECT_ID = "89abcdef0123456789abcdef"


def body(**overrides: object) -> dict[str, object]:
    return {
        "jobId": JOB_ID,
        "projectId": PROJECT_ID,
        "type": "demo",
        "payload": {"steps": 3, "stepMs": 50},
        **overrides,
    }


def fields(response_json: dict[str, object]) -> set[str]:
    error = response_json["error"]
    assert isinstance(error, dict)
    return {item["field"] for item in error["details"]}


def test_enqueue_requires_the_service_token(client: TestClient, job_queue: FakeJobQueue) -> None:
    response = client.post(JOBS, json=body())

    assert response.status_code == 401
    assert job_queue.enqueued == []


def test_enqueue_accepts_a_demo_job_with_task_id_and_request_id(
    client: TestClient, job_queue: FakeJobQueue
) -> None:
    response = client.post(JOBS, json=body(), headers={**AUTH, "X-Request-ID": "req-jobs-1"})

    assert response.status_code == 202
    assert response.json() == {"data": {"jobId": JOB_ID, "status": "queued"}, "error": None}
    [queued] = job_queue.enqueued
    assert queued.job_id == JOB_ID
    assert queued.project_id == PROJECT_ID
    assert queued.type == "demo"
    assert queued.payload == {"steps": 3, "stepMs": 50}
    assert queued.request_id == "req-jobs-1"


def test_enqueue_rejects_an_unknown_job_type(client: TestClient, job_queue: FakeJobQueue) -> None:
    response = client.post(JOBS, json=body(type="mine_bitcoin"), headers=AUTH)

    assert response.status_code == 400
    assert response.json()["error"]["details"] == [
        {"field": "body.type", "message": "unknown job type"}
    ]
    assert job_queue.enqueued == []


def test_enqueue_validates_the_payload_for_its_type(
    client: TestClient, job_queue: FakeJobQueue
) -> None:
    response = client.post(
        JOBS, json=body(payload={"steps": 0, "stepMs": 5, "extra": 1}), headers=AUTH
    )

    assert response.status_code == 400
    assert fields(response.json()) == {
        "body.payload.steps",
        "body.payload.stepMs",
        "body.payload.extra",
    }
    assert job_queue.enqueued == []


def test_enqueue_validates_ids_and_unknown_fields(client: TestClient) -> None:
    response = client.post(
        JOBS, json=body(jobId="nope", projectId="../x", priority="high"), headers=AUTH
    )

    assert response.status_code == 400
    assert fields(response.json()) == {"body.jobId", "body.projectId", "body.priority"}


def test_enqueue_returns_503_when_the_queue_is_down(
    client: TestClient, job_queue: FakeJobQueue
) -> None:
    job_queue.down = True

    response = client.post(JOBS, json=body(), headers=AUTH)

    assert response.status_code == 503
    assert response.json()["error"]["code"] == "QUEUE_UNAVAILABLE"


def test_cancel_requests_cancellation(client: TestClient, job_queue: FakeJobQueue) -> None:
    response = client.post(f"{JOBS}/{JOB_ID}/cancel", headers=AUTH)

    assert response.status_code == 202
    assert response.json() == {
        "data": {"jobId": JOB_ID, "cancelRequested": True},
        "error": None,
    }
    assert job_queue.cancelled == [JOB_ID]


def test_cancel_requires_token_and_a_valid_id(client: TestClient, job_queue: FakeJobQueue) -> None:
    assert client.post(f"{JOBS}/{JOB_ID}/cancel").status_code == 401
    response = client.post(f"{JOBS}/not-an-id/cancel", headers=AUTH)

    assert response.status_code == 400
    assert fields(response.json()) == {"path.job_id"}
    assert job_queue.cancelled == []


def test_cancel_returns_503_when_the_queue_is_down(
    client: TestClient, job_queue: FakeJobQueue
) -> None:
    job_queue.down = True

    response = client.post(f"{JOBS}/{JOB_ID}/cancel", headers=AUTH)

    assert response.status_code == 503
    assert response.json()["error"]["code"] == "QUEUE_UNAVAILABLE"


def test_enqueue_accepts_a_profile_job_and_validates_its_source_id(
    client: TestClient, job_queue: FakeJobQueue
) -> None:
    ok = client.post(JOBS, json=body(type="profile", payload={"sourceId": "a" * 24}), headers=AUTH)
    bad = client.post(
        JOBS, json=body(type="profile", payload={"sourceId": "../../etc"}), headers=AUTH
    )

    assert ok.status_code == 202
    assert [q.payload for q in job_queue.enqueued] == [{"sourceId": "a" * 24}]
    assert bad.status_code == 400
