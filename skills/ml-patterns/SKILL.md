---
name: ml-patterns
domains: [ml, data]
description: Reproducible ML code, proper train/val/test splits, logging, model persistence
---

## ML Implementation Standards

### Reproducibility
- Always set `random_state` / `seed` parameters
- Log all hyperparameters before training
- Save model artifacts with versioned filenames: `model_v{timestamp}.pkl`

### Data splits
```python
from sklearn.model_selection import train_test_split

X_train, X_test, y_train, y_test = train_test_split(
    X, y, test_size=0.2, random_state=42, stratify=y
)
# Never use test set during development — only for final evaluation
```

### Training loop
```python
import logging
logger = logging.getLogger(__name__)

def train(X_train, y_train, params: dict) -> Model:
    logger.info("Training with params: %s", params)
    model = Model(**params)
    model.fit(X_train, y_train)
    logger.info("Training complete. Score: %.4f", model.score(X_train, y_train))
    return model
```

### Evaluation
- Always report: accuracy/AUC + confusion matrix for classification
- Report: RMSE + R² for regression
- Use cross-validation for model selection, not the test set

### Persistence
```python
import joblib, time
joblib.dump(model, f"models/model_v{int(time.time())}.pkl")
```

**No hardcoded paths. Use `pathlib.Path`. No globals for model state.**
