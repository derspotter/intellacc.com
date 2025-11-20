use wasm_bindgen::prelude::*;
use openmls::prelude::*;
use openmls_rust_crypto::OpenMlsRustCrypto;
use openmls_basic_credential::SignatureKeyPair;

#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace = console)]
    fn log(s: &str);
}

#[wasm_bindgen]
pub fn init_logging() {
    console_error_panic_hook::set_once();
    log("OpenMLS WASM initialized");
}

use std::collections::HashMap;

#[wasm_bindgen]
pub struct MlsClient {
    // Store the serialized KeyPackageBundle (contains private keys)
    key_package_bundle: Option<Vec<u8>>, 
    // Store the serialized Credential
    credential: Option<Vec<u8>>,
    // Store the serialized SignatureKeyPair (needed for signing group messages)
    signature_keypair: Option<Vec<u8>>,
    // Store active groups in memory (GroupId bytes -> MlsGroup)
    // Note: MlsGroup is not directly serializable, so we keep it in memory.
    // For persistence, we would need to serialize the group state (export_group_state).
    #[wasm_bindgen(skip)]
    pub groups: HashMap<Vec<u8>, MlsGroup>,
}

#[wasm_bindgen]
impl MlsClient {
    #[wasm_bindgen(constructor)]
    pub fn new() -> MlsClient {
        MlsClient {
            key_package_bundle: None,
            credential: None,
            signature_keypair: None,
            groups: HashMap::new(),
        }
    }

    // ... existing methods ...

    pub fn create_group(&mut self, group_id_bytes: &[u8]) -> Result<Vec<u8>, JsValue> {
        let provider = OpenMlsRustCrypto::default();
        
        // Deserialize SignatureKeyPair
        let signature_key_bytes = self.signature_keypair.as_ref()
            .ok_or_else(|| JsValue::from_str("No signature keypair available"))?;
        let signature_keypair: SignatureKeyPair = serde_json::from_slice(signature_key_bytes)
            .map_err(|e| JsValue::from_str(&format!("Error deserializing signature keypair: {:?}", e)))?;

        // Deserialize Credential
        let credential_bytes = self.credential.as_ref()
            .ok_or_else(|| JsValue::from_str("No credential available"))?;
        // Use tls_codec to deserialize credential
        use tls_codec::Deserialize;
        let mut slice = credential_bytes.as_slice();
        let credential = Credential::tls_deserialize(&mut slice)
            .map_err(|e| JsValue::from_str(&format!("Error deserializing credential: {:?}", e)))?;

        let credential_with_key = CredentialWithKey {
            credential,
            signature_key: signature_keypair.to_public_vec().into(),
        };

        let group_config = MlsGroupCreateConfig::builder()
            .wire_format_policy(WireFormatPolicy::default())
            .build();
            
        let group_id = GroupId::from_slice(group_id_bytes);
        
        let group = MlsGroup::new_with_group_id(
            &provider,
            &signature_keypair,
            &group_config,
            group_id,
            credential_with_key,
        ).map_err(|e| JsValue::from_str(&format!("Error creating group: {:?}", e)))?;
        
        self.groups.insert(group_id_bytes.to_vec(), group);
        
        Ok(group_id_bytes.to_vec())
    }

    // ... existing getters ...


    pub fn create_identity(&mut self, identity_name: &str) -> Result<String, JsValue> {
        let provider = &OpenMlsRustCrypto::default();
        let ciphersuite = Ciphersuite::MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519;
        
        // Generate a signature key pair
        let signature_keypair = SignatureKeyPair::new(ciphersuite.signature_algorithm())
            .map_err(|e| JsValue::from_str(&format!("Error creating signature keypair: {:?}", e)))?;

        // Create a basic credential (arguments: credential_type first, then identity)
        let credential = Credential::new(
            CredentialType::Basic,
            identity_name.as_bytes().to_vec(),
        );
        
        let credential_with_key = CredentialWithKey {
            credential: credential.clone(),
            signature_key: signature_keypair.to_public_vec().into(),
        };

        // Build the key package
        let key_package_bundle = KeyPackage::builder()
            .build(
                ciphersuite,
                provider,
                &signature_keypair,
                credential_with_key,
            )
            .map_err(|e| JsValue::from_str(&format!("Error creating key package: {:?}", e)))?;

        // Store credential identity for later use
        use tls_codec::Serialize;
        self.credential = Some(
            credential.tls_serialize_detached()
                .map_err(|e| JsValue::from_str(&format!("Credential serialization error: {:?}", e)))?
        );
        
        // Serialize and store the KeyPackageBundle
        self.key_package_bundle = Some(
            serde_json::to_vec(&key_package_bundle)
                .map_err(|e| JsValue::from_str(&format!("KeyPackageBundle serialization error: {:?}", e)))?
        );

        // Serialize and store the SignatureKeyPair
        // SignatureKeyPair implements Serialize via serde
        self.signature_keypair = Some(
            serde_json::to_vec(&signature_keypair)
                .map_err(|e| JsValue::from_str(&format!("SignatureKeyPair serialization error: {:?}", e)))?
        );
        
        log(&format!("Identity created for: {}", identity_name));
        
        Ok("Identity created".to_string())
    }

    pub fn get_key_package_bytes(&self) -> Result<Vec<u8>, JsValue> {
        // Deserialize the bundle to extract the public KeyPackage
        if let Some(bundle_bytes) = &self.key_package_bundle {
            let bundle: KeyPackageBundle = serde_json::from_slice(bundle_bytes)
                .map_err(|e| JsValue::from_str(&format!("Error deserializing bundle: {:?}", e)))?;
            
            // Serialize just the public KeyPackage part using TLS codec (for wire format)
            use tls_codec::Serialize;
            let key_package_bytes = bundle.key_package().tls_serialize_detached()
                .map_err(|e| JsValue::from_str(&format!("Error serializing public key package: {:?}", e)))?;
                
            Ok(key_package_bytes)
        } else {
            Err(JsValue::from_str("No identity created yet"))
        }
    }

    pub fn get_credential_bytes(&self) -> Result<Vec<u8>, JsValue> {
        self.credential.clone().ok_or_else(|| JsValue::from_str("No credential available"))
    }

    pub fn get_key_package_bundle_bytes(&self) -> Result<Vec<u8>, JsValue> {
        self.key_package_bundle.clone().ok_or_else(|| JsValue::from_str("No key package bundle available"))
    }

    pub fn get_signature_keypair_bytes(&self) -> Result<Vec<u8>, JsValue> {
        self.signature_keypair.clone().ok_or_else(|| JsValue::from_str("No signature keypair available"))
    }

    pub fn restore_identity(&mut self, credential_bytes: Vec<u8>, bundle_bytes: Vec<u8>, signature_key_bytes: Vec<u8>) -> Result<(), JsValue> {
        self.credential = Some(credential_bytes);
        self.key_package_bundle = Some(bundle_bytes);
        self.signature_keypair = Some(signature_key_bytes);
        Ok(())
    }
}
