from celery import Celery
from celery.schedules import crontab
import os

celery = Celery("retailos",
    broker=os.getenv("REDIS_URL","redis://localhost:6379/1"),
    backend=os.getenv("REDIS_URL","redis://localhost:6379/1"),
    include=["app.workers.scheduled","app.workers.notification"])

celery.conf.timezone = "Asia/Kolkata"
celery.conf.beat_schedule = {
    "khata-reminders-daily": {
        "task": "app.workers.scheduled.send_khata_reminders_all_stores",
        "schedule": crontab(hour=9, minute=0),  # 9 AM IST
    },
    "expiry-alerts-daily": {
        "task": "app.workers.scheduled.check_expiry_alerts_all_stores",
        "schedule": crontab(hour=7, minute=0),  # 7 AM IST
    },
    "cadence-compute-nightly": {
        "task": "app.workers.scheduled.compute_cadence_all_stores",
        "schedule": crontab(hour=2, minute=0),  # 2 AM IST
    },
    "trust-score-nightly": {
        "task": "app.workers.scheduled.recompute_all_trust_scores",
        "schedule": crontab(hour=1, minute=0),  # 1 AM IST
    },
    "ad-quality-scores-hourly": {
        "task": "app.workers.scheduled.update_ad_quality_scores",
        "schedule": crontab(minute=0),  # Every hour
    },
}
