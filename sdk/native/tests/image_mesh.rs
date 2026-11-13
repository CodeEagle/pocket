use pocketjs_core::{Ui, spec};

fn geometry_with_uvs(x: f32, color: u32, uvs: [f32; 6]) -> Vec<u8> {
    let mut bytes = Vec::new();
    for v in [0x31534d50u32, 3, 3, color] { bytes.extend(v.to_le_bytes()); }
    for v in [x, 10.0, uvs[0], uvs[1], 80.0, 10.0, uvs[2], uvs[3], 30.0, 80.0, uvs[4], uvs[5]] { bytes.extend(v.to_le_bytes()); }
    for v in [0u32, 1, 2] { bytes.extend(v.to_le_bytes()); }
    bytes
}

fn geometry_with_color(x: f32, color: u32) -> Vec<u8> {
    geometry_with_uvs(x, color, [0.0, 0.0, 1.0, 0.0, 0.5, 1.0])
}

fn geometry(x: f32) -> Vec<u8> { geometry_with_color(x, 0x80ffffff) }

fn effect_flags(mask_id: Option<i32>, blend: u32, flags: u32) -> Vec<u8> {
    let mut bytes = Vec::new();
    for word in [0x3158464du32, blend, u32::from(mask_id.is_some()), flags] {
        bytes.extend(word.to_le_bytes());
    }
    for value in [1.0f32, 1.0, 1.0, 0.0, 0.0, 0.0] {
        bytes.extend(value.to_le_bytes());
    }
    if let Some(mask_id) = mask_id { bytes.extend((mask_id as u32).to_le_bytes()); }
    bytes
}

fn effect(mask_id: i32, inverted: bool) -> Vec<u8> {
    effect_flags(Some(mask_id), 2, u32::from(inverted))
}

#[test]
fn retained_mesh_deforms_clips_is_atomic_and_releases_its_storage() {
    let mut ui = Ui::new();
    ui.set_viewport(100.0, 100.0);
    let node = ui.create_node(spec::NodeType::Image as u8);
    ui.insert_before(spec::ROOT_ID, node, 0);
    ui.set_prop(node, spec::prop::WIDTH, 100.0);
    ui.set_prop(node, spec::prop::HEIGHT, 100.0);
    let texture = ui.upload_texture(&[255; 16], 2, 2, spec::psm::PSM_8888);
    assert!(texture >= 0);
    assert!(ui.set_mesh(node, texture, &geometry(10.0)));
    let allocation = ui.mesh_memory_bytes();
    ui.tick();
    let before = ui.draw().words.clone();
    assert_eq!(before[0], spec::draw_op::TEX_TRI_FLOAT);
    assert_eq!(before.len(), 15);
    assert_eq!(before[14], 0x80ffffff);
    assert!(ui.set_mesh(node, texture, &geometry(-20.0)));
    assert_eq!(ui.mesh_memory_bytes(), allocation); // fixed topology reuses storage
    let clipped = ui.draw().words.clone();
    assert_ne!(before, clipped);
    for op in clipped.chunks_exact(15) {
        for (x, y) in [(op[2], op[3]), (op[6], op[7]), (op[10], op[11])] {
            assert!((0.0..=100.0).contains(&f32::from_bits(x)));
            assert!((0.0..=100.0).contains(&f32::from_bits(y)));
        }
    }
    let mut invalid = geometry(25.0);
    invalid[16..20].copy_from_slice(&f32::NAN.to_le_bytes());
    assert!(!ui.set_mesh(node, texture, &invalid));
    assert_eq!(ui.draw().words, clipped);
    invalid = geometry(25.0);
    let last = invalid.len() - 4;
    invalid[last..].copy_from_slice(&3u32.to_le_bytes());
    assert!(!ui.set_mesh(node, texture, &invalid));
    assert_eq!(ui.draw().words, clipped);
    ui.destroy_node(node);
    assert_eq!(ui.mesh_memory_bytes(), 0);
    assert!(!ui.set_mesh(node, texture, &geometry(10.0)));
}

#[test]
fn mesh_effect_drawlist_emits_one_hidden_mask_group_and_validates_references() {
    let mut ui = Ui::new();
    ui.set_viewport(100.0, 100.0);
    let target = ui.create_node(spec::NodeType::Image as u8);
    let mask = ui.create_node(spec::NodeType::Image as u8);
    ui.insert_before(spec::ROOT_ID, target, 0);
    ui.insert_before(spec::ROOT_ID, mask, 0);
    for node in [target, mask] {
        ui.set_prop(node, spec::prop::WIDTH, 100.0);
        ui.set_prop(node, spec::prop::HEIGHT, 100.0);
        ui.set_prop(node, spec::prop::POS_TYPE, 1.0);
        ui.set_prop(node, spec::prop::INSET_T, 0.0);
        ui.set_prop(node, spec::prop::INSET_L, 0.0);
    }
    let texture = ui.upload_texture(&[255; 16], 2, 2, spec::psm::PSM_8888);
    assert!(ui.set_mesh(target, texture, &geometry(10.0)));
    let target_allocation = ui.mesh_memory_bytes();
    assert!(ui.set_mesh(mask, texture, &geometry(25.0)));
    let mask_allocation = ui.mesh_memory_bytes() - target_allocation;
    ui.set_prop(mask, spec::prop::OPACITY, 0.0);
    assert!(ui.set_mesh_effect(target, &effect(mask, false)));
    let retained = ui.mesh_memory_bytes();

    let words = ui.draw().words.clone();
    pocket_draw_ops::validate(&words, pocket_drivers::DamageRect::new(0, 0, 100, 100)).unwrap();
    let layer = words.iter().position(|word| *word == spec::draw_op::MESH_LAYER_BEGIN).unwrap();
    let mask_begin = words.iter().position(|word| *word == spec::draw_op::MESH_MASK_BEGIN).unwrap();
    let restore = words.iter().position(|word| *word == spec::draw_op::MESH_LAYER_RESTORE).unwrap();
    assert!(layer < mask_begin && mask_begin < restore);
    assert_eq!(words[layer + 3], 2); // multiply blend
    assert_eq!(words[mask_begin + 1], 0);
    assert_eq!(words[mask_begin + 2], words[layer + 1]);
    assert_eq!(words[mask_begin + 3], words[layer + 2]);
    assert_eq!(
        words.iter().filter(|word| **word == spec::draw_op::TEX_TRI_FLOAT).count(),
        2,
        "DrawList: {words:?}"
    );
    for source_color in [0x00ffffff, 0x40ff80ff] {
        assert!(ui.set_mesh(mask, texture, &geometry_with_color(25.0, source_color)));
        let sampled = ui.draw().words.clone();
        let colors: Vec<_> = sampled
            .iter()
            .enumerate()
            .filter(|(_, word)| **word == spec::draw_op::TEX_TRI_FLOAT)
            .map(|(index, _)| sampled[index + 14])
            .collect();
        assert_eq!(colors.len(), 2);
        assert_eq!(colors[0], 0x80ffffff, "target PMS1 modulation remains intact");
        assert_eq!(
            colors[1],
            u32::MAX,
            "mask samples texture alpha only, regardless of PMS1 color {source_color:#010x}"
        );
    }
    assert_eq!(ui.mesh_memory_bytes(), retained);

    let mut invalid = effect(mask, true);
    invalid[0..4].copy_from_slice(&0u32.to_le_bytes());
    assert!(!ui.set_mesh_effect(target, &invalid));
    assert_eq!(ui.draw().words, words);

    ui.destroy_node(mask);
    assert_eq!(ui.mesh_memory_bytes(), retained - mask_allocation);
    // A destroyed generation-tagged mask is no longer emitted; non-inverted
    // masking remains an empty (transparent) mask rather than drawing stale data.
    let after_destroy = ui.draw().words.clone();
    pocket_draw_ops::validate(&after_destroy, pocket_drivers::DamageRect::new(0, 0, 100, 100)).unwrap();
    assert_eq!(after_destroy.iter().filter(|word| **word == spec::draw_op::TEX_TRI_FLOAT).count(), 1);
}

#[test]
fn repeat_sampler_preserves_bounded_uvs_and_skips_redundant_composite_layer() {
    let mut ui = Ui::new();
    ui.set_viewport(100.0, 100.0);
    let node = ui.create_node(spec::NodeType::Image as u8);
    ui.insert_before(spec::ROOT_ID, node, 0);
    ui.set_prop(node, spec::prop::WIDTH, 100.0);
    ui.set_prop(node, spec::prop::HEIGHT, 100.0);
    let texture = ui.upload_texture(&[255; 16], 2, 2, spec::psm::PSM_8888);
    let uvs = [-0.000322, 0.0, 1.00096, 0.0, 0.5, 1.25];
    let mesh = geometry_with_uvs(10.0, 0x80ffffff, uvs);
    assert!(ui.set_mesh(node, texture, &mesh));
    assert!(ui.set_mesh_effect(node, &effect_flags(None, 0, 2)));
    let retained = ui.mesh_memory_bytes();
    for _ in 0..32 {
        assert!(ui.set_mesh_effect(node, &effect_flags(None, 0, 2)));
        assert_eq!(ui.mesh_memory_bytes(), retained);
    }

    let words = ui.draw().words.clone();
    assert_eq!(words[0], spec::draw_op::TEX_TRI_REPEAT_FLOAT);
    assert!(!words.contains(&spec::draw_op::MESH_LAYER_BEGIN));
    assert_eq!(f32::from_bits(words[4]), uvs[0]);
    assert_eq!(f32::from_bits(words[8]), uvs[2]);
    assert_eq!(f32::from_bits(words[13]), uvs[5]);

    let invalid = geometry_with_uvs(10.0, 0x80ffffff, [0.0, 0.0, 1_000_001.0, 0.0, 0.5, 1.0]);
    assert!(!ui.set_mesh(node, texture, &invalid));
    assert_eq!(ui.draw().words, words, "invalid update leaves the prior mesh intact");
}

#[test]
fn repeat_sampler_applies_to_hidden_mask_triangles_without_changing_target_sampler() {
    let mut ui = Ui::new();
    ui.set_viewport(100.0, 100.0);
    let target = ui.create_node(spec::NodeType::Image as u8);
    let mask = ui.create_node(spec::NodeType::Image as u8);
    for node in [target, mask] {
        ui.insert_before(spec::ROOT_ID, node, 0);
        ui.set_prop(node, spec::prop::WIDTH, 100.0);
        ui.set_prop(node, spec::prop::HEIGHT, 100.0);
        ui.set_prop(node, spec::prop::POS_TYPE, 1.0);
        ui.set_prop(node, spec::prop::INSET_T, 0.0);
        ui.set_prop(node, spec::prop::INSET_L, 0.0);
    }
    let texture = ui.upload_texture(&[255; 16], 2, 2, spec::psm::PSM_8888);
    assert!(ui.set_mesh(target, texture, &geometry(10.0)));
    assert!(ui.set_mesh(mask, texture, &geometry_with_uvs(
        10.0,
        0x00ffffff,
        [-0.000322, 0.0, 1.00096, 0.0, 0.5, 1.25],
    )));
    ui.set_prop(mask, spec::prop::OPACITY, 0.0);
    assert!(ui.set_mesh_effect(target, &effect(mask, false)));
    assert!(ui.set_mesh_effect(mask, &effect_flags(None, 0, 2)));

    let words = ui.draw().words.clone();
    let target_tri = words.iter().position(|word| *word == spec::draw_op::TEX_TRI_FLOAT).unwrap();
    let mask_tri = words.iter().position(|word| *word == spec::draw_op::TEX_TRI_REPEAT_FLOAT).unwrap();
    assert!(target_tri < mask_tri);
    assert_eq!(words[target_tri + 14], 0x80ffffff);
    assert_eq!(words[mask_tri + 14], u32::MAX);
}

#[test]
fn retained_mesh_drawlist_keeps_fractional_positions() {
    let mut ui = Ui::new();
    ui.set_viewport(100.0, 100.0);
    let node = ui.create_node(spec::NodeType::Image as u8);
    ui.insert_before(spec::ROOT_ID, node, 0);
    ui.set_prop(node, spec::prop::WIDTH, 100.0);
    ui.set_prop(node, spec::prop::HEIGHT, 100.0);
    let texture = ui.upload_texture(&[255; 16], 2, 2, spec::psm::PSM_8888);
    assert!(ui.set_mesh(node, texture, &geometry(10.25)));

    let words = ui.draw().words.clone();
    assert_eq!(words[0], spec::draw_op::TEX_TRI_FLOAT);
    let positions = [(words[2], words[3]), (words[6], words[7]), (words[10], words[11])];
    assert!(positions.into_iter().any(|(x, y)| {
        let (x, y) = (f32::from_bits(x), f32::from_bits(y));
        x.fract() != 0.0 || y.fract() != 0.0
    }), "Core output should retain the input mesh's quarter-pixel coordinate: {words:?}");
}

#[test]
fn equal_mesh_submission_recovers_after_image_clear_and_validates_texture_lifetime() {
    let mut ui = Ui::new();
    ui.set_viewport(100.0, 100.0);
    let node = ui.create_node(spec::NodeType::Image as u8);
    ui.insert_before(spec::ROOT_ID, node, 0);
    ui.set_prop(node, spec::prop::WIDTH, 100.0);
    ui.set_prop(node, spec::prop::HEIGHT, 100.0);
    let texture = ui.upload_texture(&[255; 16], 2, 2, spec::psm::PSM_8888);
    let second = ui.upload_texture(&[128; 16], 2, 2, spec::psm::PSM_8888);
    let bytes = geometry(10.0);
    assert!(ui.set_mesh(node, texture, &bytes));
    let original = ui.draw().words.clone();
    let allocation = ui.mesh_memory_bytes();
    assert_eq!(original[0], spec::draw_op::TEX_TRI_FLOAT);
    assert!(ui.set_mesh(node, texture, &bytes));
    assert_eq!(ui.draw().words, original);
    assert_eq!(ui.mesh_memory_bytes(), allocation);

    ui.set_image(node, -1);
    assert_eq!(ui.mesh_memory_bytes(), 0);
    assert!(ui.draw().words.is_empty());
    assert!(ui.set_mesh(node, texture, &bytes));
    assert_eq!(ui.draw().words, original, "identical bytes must reinstall a cleared mesh");
    assert_eq!(ui.mesh_memory_bytes(), allocation);

    ui.set_image(node, texture);
    assert_eq!(ui.mesh_memory_bytes(), 0);
    assert!(ui.set_mesh(node, texture, &bytes));
    assert_eq!(ui.draw().words, original, "keeping the same texture does not keep the old mesh");

    ui.set_sprite(node, texture, 2, 2, 1);
    assert_eq!(ui.mesh_memory_bytes(), 0);
    assert!(ui.set_mesh(node, texture, &bytes));
    assert_eq!(ui.draw().words, original, "a sprite write must not leave a stale mesh cache");

    assert!(ui.set_mesh(node, second, &bytes));
    let changed_texture = ui.draw().words.clone();
    assert_ne!(changed_texture, original, "texture identity participates in the update");
    ui.free_texture(second);
    assert!(!ui.set_mesh(node, second, &bytes), "an equal retained payload cannot validate a freed texture");
    assert!(ui.set_mesh(node, texture, &bytes));
    assert_eq!(ui.draw().words, original);

    let mut invalid = bytes.clone();
    invalid[16..20].copy_from_slice(&f32::NAN.to_le_bytes());
    assert!(!ui.set_mesh(node, texture, &invalid));
    assert_eq!(ui.draw().words, original, "a rejected mutation leaves the valid retained mesh intact");
    assert!(ui.set_mesh(node, texture, &[]));
    assert_eq!(ui.mesh_memory_bytes(), 0);
    assert!(ui.set_mesh(node, texture, &bytes));
    assert_eq!(ui.draw().words, original, "the explicit empty mesh clear must also allow restoration");
}
