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

#[wasm_bindgen]
pub struct MlsClient {
    // Store the key package bundle which contains private keys
    key_package_bundle: Option<Vec<u8>>, // Serialized for JS interop
    credential: Option<Vec<u8>>, // Serialized credential
}

#[wasm_bindgen]
impl MlsClient {
    #[wasm_bindgen(constructor)]
    pub fn new() -> MlsClient {
        MlsClient {
            key_package_bundle: None,
            credential: None,
        }
    }

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
        let _key_package_bundle = KeyPackage::builder()
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
        
        log(&format!("Identity created for: {}", identity_name));
        
        Ok("Identity created".to_string())
    }

    pub fn get_key_package_bytes(&self) -> Result<Vec<u8>, JsValue> {
        // This needs to be implemented properly when we figure out state management
        Err(JsValue::from_str("Not yet implemented - need to manage KeyPackageBundle state"))
    }
}
