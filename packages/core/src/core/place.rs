use serde_json::Value;

use crate::core::error::{CoreError, CoreResult};

/// Optional WGS84 coordinates in decimal degrees. A location is always a complete pair.
pub fn validate_coordinates(value: Option<&Value>) -> CoreResult<()> {
    let Some(value) = value else {
        return Ok(());
    };
    let coordinates = value
        .as_object()
        .ok_or_else(|| CoreError::Validation("place.coordinates must be an object".to_owned()))?;
    if coordinates
        .keys()
        .any(|key| !matches!(key.as_str(), "latitude" | "longitude"))
    {
        return Err(CoreError::Validation(
            "place.coordinates only accepts latitude and longitude".to_owned(),
        ));
    }
    for (field, limit) in [("latitude", 90.0), ("longitude", 180.0)] {
        coordinates
            .get(field)
            .and_then(Value::as_f64)
            .filter(|number| number.is_finite() && (-limit..=limit).contains(number))
            .ok_or_else(|| {
                CoreError::Validation(format!(
                    "place.coordinates.{field} must be a finite number between -{limit} and {limit}"
                ))
            })?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn accepts_legacy_places_zero_and_coordinate_boundaries() {
        validate_coordinates(None).expect("legacy place without GPS");
        for coordinates in [
            json!({ "latitude": 26.0745, "longitude": 119.2965 }),
            json!({ "latitude": 0, "longitude": 0 }),
            json!({ "latitude": -90, "longitude": -180 }),
            json!({ "latitude": 90, "longitude": 180 }),
        ] {
            validate_coordinates(Some(&coordinates)).expect("valid coordinates");
        }
    }

    #[test]
    fn rejects_incomplete_non_numeric_and_out_of_range_coordinates() {
        for coordinates in [
            Value::Null,
            json!([]),
            json!({}),
            json!({ "latitude": 26.0745 }),
            json!({ "longitude": 119.2965 }),
            json!({ "latitude": "26.0745", "longitude": 119.2965 }),
            json!({ "latitude": 26.0745, "longitude": null }),
            json!({ "latitude": 90.000001, "longitude": 0 }),
            json!({ "latitude": -90.000001, "longitude": 0 }),
            json!({ "latitude": 0, "longitude": 180.000001 }),
            json!({ "latitude": 0, "longitude": -180.000001 }),
            json!({ "latitude": 0, "longitude": 0, "crs": "GCJ02" }),
        ] {
            assert!(matches!(
                validate_coordinates(Some(&coordinates)),
                Err(CoreError::Validation(_))
            ));
        }
    }
}
