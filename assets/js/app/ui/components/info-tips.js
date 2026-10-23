/**
 * @fileoverview The text of every (i) tip in the interface, and the one
 * renderer that draws it.
 *
 * A tip answers three questions about the heading or control it sits beside:
 * what it does, when to reach for it (and what it costs), and how it
 * interacts with the settings around it. It ends with one or more links to
 * the documentation page that explains it fully. Facts here are read from the
 * code that implements them, not from older copy; when behaviour changes, the
 * tip changes with it.
 *
 * Markup in static HTML names its tip with `data-info-tip="<key>"` on the
 * `.info-tooltip` element; components built in JavaScript pass the key to
 * {@link renderInfoTip}. `tests/info-tips-contract.test.mjs` holds every key
 * used to an entry here, every entry to a docs link, and every link to a page
 * and heading anchor that exists in the documentation.
 *
 * @module ui/components/info-tips
 */

export const DOCS_BASE_URL = 'https://docs.cellucid.com/en/latest/user_guide/web_app/';

/**
 * One documentation link: a short text naming the target, and the page and
 * heading anchor under {@link DOCS_BASE_URL}.
 *
 * @param {string} label
 * @param {string} page - path below `user_guide/web_app/`, without `.html`
 * @param {string} [anchor] - the heading's anchor id on that page
 */
function doc(label, page, anchor) {
  return Object.freeze({ label, page, anchor: anchor ?? null });
}

/**
 * A tip body is a list of blocks: a string is a paragraph, `{ list: [...] }`
 * a bulleted list. Text between backticks is set as code.
 */
const TIPS = {
  // ---------------------------------------------------------------- Session
  'dataset': {
    title: 'Dataset',
    body: [
      'Facts about the dataset that is open now: its name and description, where it was loaded from, and how many cells, genes and obs fields it has.',
      'Connectivity counts the edges of the neighbour graph in use. Without one, KNN connectivity edges and the KNN drag tool are unavailable.',
      'Sessions and community annotations are tied to this dataset’s identity, so they only restore onto the same dataset.',
    ],
    links: [
      doc('Dataset identity', 'b_data_loading/06_dataset_identity_why_it_matters', 'the-one-sentence-definition'),
    ],
  },
  'data-mapping': {
    title: 'Data mapping',
    body: [
      'Which stored arrays this dataset is drawn from: the embeddings views can show -- any number, of any mix of 1D, 2D and 3D -- the neighbour graph, the gene names and expression matrix, the latent space of outlier filters and the vector fields.',
      'A dataset (an `.h5ad` or Zarr store opened in the browser, from a link or the samples, served by `cellucid serve`, or shown from a notebook) can use any of its `obsm` arrays (at any 1 to 3 of their columns), `obsp` graphs and expression matrices.',
      'A file without a UMAP opens on a best guess, marked guessed. Sessions record the mapping and restore it.',
    ],
    links: [
      doc('Data mapping', 'b_data_loading/13_data_mapping', 'at-a-glance'),
      doc('Best guess', 'b_data_loading/13_data_mapping', 'files-without-a-umap-the-best-guess'),
    ],
  },

  'data-mapping-embeddings': {
    title: 'Embeddings',
    body: [
      'Turn on every embedding a view may show -- several of one dimension too, such as UMAP, t-SNE and PCA in 2D. Turning one on loads nothing until a view shows it.',
      'Default marks the one embedding per dimension that new views of that dimension, and the keys 1, 2 and 3, show first. A view you turned to an embedding keeps it when the default changes.',
      'An embedding’s dimension (`2D`) opens its editor: show it in any dimension its columns allow -- a 3-column array in 1D, 2D or 3D, a 2-column one in 1D or 2D -- and pick the column each axis reads. For an array wider than three columns, such as `X_pca`, Add columns adds another selection (for example components 3 and 4).',
      'Apply loads and checks every embedding a view must switch to. A value that cannot be drawn (NaN or infinity) is refused, naming its cell. A view showing an embedding you turn off switches to its dimension’s default.',
    ],
    links: [
      doc('Choose the embeddings', 'b_data_loading/13_data_mapping', 'choose-the-embeddings-views-can-show'),
      doc('Dimension and columns', 'b_data_loading/13_data_mapping', 'dimension-and-columns-of-an-array'),
    ],
  },

  'data-mapping-genes': {
    title: 'Genes',
    body: [
      'Expression: the matrix gene values are read from, `X`, a layer such as `counts`, or `raw.X` (which has its own, often longer, gene list). Gene names: the var index or any var column of text, categories or integers, such as `gene_symbols` beside an Ensembl index.',
      'A missing name takes the gene’s var-index name, and repeated names are made unique (`MATR3`, `MATR3-1`), as in AnnData. A view coloured by a gene keeps it with its colour range and filter: other names for the same matrix keep its column, and `raw.X` finds it by name. A gene missing from the new list loses its colouring. Analysis windows close.',
    ],
    links: [
      doc('Genes', 'b_data_loading/13_data_mapping', 'genes-and-expression'),
    ],
  },
  'data-mapping-latent': {
    title: 'Latent space',
    body: [
      'The `obsm` space (scVI, PCA) where a categorical field’s outlier filter measures each cell’s distance to its category’s centre; the filter hides the farthest share of each category.',
      'Apply reads nothing: an outlier filter in use is measured again in the new space, with progress and Cancel, and keeps its threshold. A space with a missing value is refused when it is first read. The space a file stores outlier distances for is marked “outliers stored” and filters at once. None turns outlier filters off.',
    ],
    links: [
      doc('Latent space', 'b_data_loading/13_data_mapping', 'latent-space'),
      doc('Outlier filtering', 'e_filtering/02_outlier_filtering_per_active_field', 'stored-or-computed'),
    ],
  },
  'data-mapping-vectors': {
    title: 'Vector fields',
    body: [
      'Which `obsm` arrays are drawn as vectors (velocity, drift) on which embedding. An array fits an embedding as wide as its dimension, or as wide as the embedding’s array, read at the same columns. An array named for an embedding the way scVelo names it (`velocity_umap` for `X_umap`, `velocity_branches` for `X_branches`) is marked suggested and is bound when the file opens.',
      'A view draws a vector field only while it shows an embedding the field is bound to. Values are read when the overlay first shows them.',
    ],
    links: [
      doc('Vector fields', 'b_data_loading/13_data_mapping', 'vector-fields'),
      doc('Enable the overlay', 'i_vector_field_velocity/02_enabling_overlay_and_selecting_field', 'availability-states'),
    ],
  },
  'data-mapping-knn': {
    title: 'Neighbour graph',
    body: [
      'The graph KNN edges and the KNN selection tool use: any square `obsp` matrix with one row per cell, such as `connectivities` from `sc.pp.neighbors()` or `<key>_connectivities` from `neighbors(key_added=…)`.',
      'Apply reads and checks the graph first. It must be symmetric, with a zero diagonal and no negative or missing weight; a graph that is not, such as `distances`, is refused and stays unavailable. Shown edges are redrawn from the new graph. None turns them off.',
    ],
    links: [
      doc('Neighbour graph', 'b_data_loading/13_data_mapping', 'neighbour-graph'),
      doc('KNN drag', 'f_highlighting_selection/02_selection_tools_document_each_tool', 'tool-4-knn-drag-alt-click-drag-degree'),
    ],
  },
  'open-data': {
    title: 'Open data',
    body: [
      'Four ways to open a dataset. Opening one replaces the dataset that is open now.',
      {
        list: [
          'Sample: a public dataset, read in place as each view needs it.',
          'Files: an `.h5ad`, a `.zarr` folder or a `.zarr.zip` from this computer. Nothing is uploaded.',
          'Server: a `cellucid serve` process on this machine or through an SSH tunnel.',
          'Link: an AnnData file or a dataset catalog wherever it is published.',
        ],
      },
      'Every route reads AnnData. For large datasets, an AnnData file written by `cellucid prepare` reads fastest.',
    ],
    links: [
      doc('Loading options', 'b_data_loading/01_loading_options_overview', 'at-a-glance'),
      doc('Choose a workflow', 'b_data_loading/01_loading_options_overview', 'fast-path-choose-a-workflow-decision-tree'),
    ],
  },
  'local-files': {
    title: 'Files',
    body: [
      {
        list: [
          'H5AD: one `.h5ad` file, read in the browser. Quick for previews; very large files are limited by browser memory.',
          'Zarr ZIP: a `.zarr.zip` or `.zip` holding one AnnData Zarr store. It opens in Safari, Chrome, Edge and Firefox alike.',
          'Zarr folder: an AnnData `.zarr` store folder, as `cellucid.prepare()` and `cellucid_prepare()` write it. Choose or drop the folder itself.',
        ],
      },
      'Files stay on this computer: they are read by the browser and never uploaded.',
    ],
    links: [
      doc('Browser file picker', 'b_data_loading/03_browser_file_picker_tutorial', 'fast-path-wet-lab-friendly'),
      doc('What Cellucid reads', 'b_data_loading/07_file_format_expectations', 'the-four-things-cellucid-can-load-practical-view'),
    ],
  },
  'remote-server': {
    title: 'Server',
    body: [
      'Connects to a running `cellucid serve` process, which streams the dataset to the browser as it is needed.',
      {
        list: [
          'Same machine: run `cellucid serve data.h5ad`, then Connect to the address it prints (`localhost:8765` by default).',
          'Remote machine: forward the port first with `ssh -L 8765:localhost:8765 user@host`.',
        ],
      },
      'The server serves the `.h5ad` or Zarr store as it is; the browser reads only what each view needs.',
    ],
    links: [
      doc('Server mode', 'b_data_loading/04_server_tutorial', 'fast-path-cli'),
      doc('SSH tunnel', 'b_data_loading/04_server_tutorial', 'remote-server-access-ssh-tunnel-workflow'),
    ],
  },
  'data-link': {
    title: 'Open from link',
    body: [
      'Opens data where it already lives, reading only what each view needs. Paste a CELLxGENE dataset link or id, a GEO series (`GSE…`), a Zenodo record or DOI, a Hugging Face dataset link, a Dropbox file link, a GitHub repository (`owner/repo/path`, the folder that holds `datasets.json`), or any web address of an `.h5ad` file, a zipped Zarr store, a Zarr store folder, or a dataset catalog folder (holding `datasets.json`) ending in `/`.',
      'No sign-in is needed. The host must allow other sites to read the data (CORS). Share the page link to let anyone open the same data.',
    ],
    links: [
      doc('What you can paste', 'b_data_loading/14_open_from_link', 'what-you-can-paste'),
      doc('Why a link is refused', 'b_data_loading/14_open_from_link', 'why-a-link-can-be-refused'),
      doc('Publish a dataset repository', 'b_data_loading/11_custom_dataset_repository', 'the-repository-contract'),
    ],
  },
  transfers: {
    title: 'Transfers',
    body: [
      'Every read of linked data: what is read, from which host, why, how much has come in, and where it goes.',
      'Linked data is read in place: only the parts a view needs are requested. Nothing is saved to disk; what was read is kept in memory and released when the dataset closes.',
    ],
    links: [
      doc('Transfers', 'b_data_loading/14_open_from_link', 'transfers'),
    ],
  },
  'session-file': {
    title: 'Session file',
    body: [
      'Save writes a `.cellucid-session` file with the state of the app: views and cameras, active fields, filters, highlight pages and groups, panel layout, analysis windows and the camera path.',
      'Load restores such a file onto the same dataset. The dataset itself is not in the file, and a session saved from a different dataset is refused without changing anything.',
    ],
    links: [
      doc('What is saved', 'l_sessions_sharing/02_what_gets_saved_and_restored', 'quick-summary-read-this-if-you-only-have-60-seconds'),
      doc('Save and restore', 'l_sessions_sharing/03_save_restore_ux', 'fast-path-wet-lab-non-technical-save-my-work'),
    ],
  },

  // ---------------------------------------------------------- Visualization
  'display': {
    title: 'Display',
    body: [
      'Theme sets the colours of the interface, light or dark. Background sets what is drawn behind the cells: a grid box, a studio floor that becomes dotted paper in 2D and in level views, or plain white or black.',
      'Both apply at once and are saved in sessions.',
    ],
    links: [
      doc('Quick tour', 'a_orientation/03_quick_tour_60_seconds', 'fast-path-click-by-click'),
    ],
  },
  'cells': {
    title: 'Cells',
    body: [
      'Render mode chooses how cells are drawn. Points draws every visible cell as a dot. Volumetric smoke draws their density as a lit cloud (beta: slower, and figure export cannot reproduce it).',
      'Point size is logarithmic. It is the strongest speed lever on large datasets: smaller points cover fewer pixels.',
      'The settings below this one belong to the selected render mode.',
    ],
    links: [
      doc('Render modes', 'c_core_interactions/03_render_modes_points_vs_volumetric_smoke', 'choose-the-representation-before-tuning-it'),
      doc('Points mode', 'c_core_interactions/03_render_modes_points_vs_volumetric_smoke', 'points-mode'),
    ],
  },
  'shader-quality': {
    title: 'Shader quality',
    body: [
      'Changes what a point looks like. Full adds lighting and fog. Sculpted shades every point as a soft-lit, glossy ball with smooth edges and its legend colour at the centre, keeps fog, and holds highlighted cells still instead of pulsing them. Light drops lighting and fog, Ultra-light draws squares instead of round dots.',
      'It barely changes speed. In 3D views depth testing discards most hidden points before shading. 2D views are drawn without depth and every quality draws them without a discard, so on a dense million-cell 2D embedding with antialiasing on the qualities measured within a few percent of one another (one Apple M1 Pro).',
      'For speed in 3D, reach for point size, filtering or Performance below instead.',
    ],
    links: [
      doc('Shader quality', 'c_core_interactions/03_render_modes_points_vs_volumetric_smoke', 'points-mode'),
      doc('Rendering points, measured', 'n_benchmarking_performance/02_performance_considerations_what_gets_slow_and_why', 'rendering-points-measured'),
    ],
  },
  'antialiasing': {
    title: 'Antialiasing',
    body: [
      'Smooths the edge of every point. Small dots are almost all edge, so this changes how a dense cloud looks more than any other setting.',
      'It costs most in 2D, where every overlapping point is shaded. On one Apple M1 Pro a dense million-cell 2D view drew about 2.2 times faster without it (11.6 ms against 25.5 ms of GPU time a frame), while 18% of pixels change at point size 0.75.',
      'Until you set it yourself it is chosen automatically: on below 5,000,000 cells in a 3D view and below 200,000 in a 1D or 2D view. It is decided again when a dataset opens or the view changes dimension. Setting it here keeps your choice.',
    ],
    links: [
      doc('What gets slow', 'n_benchmarking_performance/02_performance_considerations_what_gets_slow_and_why', 'rendering-points-measured'),
      doc('Settings that change themselves', 'n_benchmarking_performance/06_edge_cases_performance', 'edge-case-two-settings-changed-themselves-when-you-opened-another-dataset'),
    ],
  },
  'depth-cues': {
    title: 'Depth cues',
    body: [
      'Lighting shades each point like a small sphere, fog fades distant points, and perspective scaling draws far points smaller. Together they make 3D structure readable.',
      'They matter in 3D views; a flat embedding has no depth to show. Light and Ultra-light shader quality turn lighting and fog off; Full and Sculpted keep both.',
    ],
    links: [
      doc('Points mode', 'c_core_interactions/03_render_modes_points_vs_volumetric_smoke', 'points-mode'),
    ],
  },
  'render-performance': {
    title: 'Performance',
    body: [
      'Level of detail draws a reduced set of points when the camera is far away and the full set as you zoom in. Force LOD level pins one level, to check what a level looks like.',
      'Frustum culling skips points outside the view, which helps when you are zoomed in on part of a large dataset.',
      'Both build a spatial index the first time they are turned on, which takes a moment on large data. They help most with millions of cells and with several views open.',
    ],
    links: [
      doc('Large datasets', 'n_benchmarking_performance/03_large_dataset_best_practices', 'fast-path-large-dataset-survival-checklist-copy-paste-mental-defaults'),
      doc('Multiview on large data', 'n_benchmarking_performance/06_edge_cases_performance', 'edge-case-multiview-on-a-large-dataset'),
    ],
  },
  'smoke-quality': {
    title: 'Smoke quality',
    body: [
      'Grid density sets how finely the cloud samples cell density; it is the only smoke setting that rebuilds the cloud. Every other smoke setting applies on the next frame.',
      'Ray quality and render resolution trade sharpness for speed: lower them first when smoke is slow. Noise detail sets the resolution of the texture that breaks up the cloud.',
    ],
    links: [
      doc('Smoke controls', 'c_core_interactions/03_render_modes_points_vs_volumetric_smoke', 'smoke-controls-exact-current-inventory'),
      doc('What is rebuilt', 'c_core_interactions/03_render_modes_points_vs_volumetric_smoke', 'what-is-rebuilt-and-when'),
    ],
  },
  'smoke-shape': {
    title: 'Smoke shape',
    body: [
      'Cloud density scales how opaque the cloud is. Fine detail and turbulence add texture; edge softness fades the cloud’s boundary.',
      'Animation speed moves the texture. At 0 the cloud is still and nothing is redrawn while the view is still.',
    ],
    links: [
      doc('Smoke controls', 'c_core_interactions/03_render_modes_points_vs_volumetric_smoke', 'smoke-controls-exact-current-inventory'),
    ],
  },
  'smoke-lighting': {
    title: 'Smoke lighting',
    body: [
      'Absorption sets how quickly light dims inside the cloud, scattering how much it glows, and direct lighting how strongly the light source shades it.',
      'Raise absorption to reveal dense cores; lower it to see through the cloud.',
    ],
    links: [
      doc('What the smoke shows', 'c_core_interactions/03_render_modes_points_vs_volumetric_smoke', 'what-the-smoke-cloud-shows'),
    ],
  },
  'connectivity': {
    title: 'Connectivity',
    body: [
      'Draws the dataset’s neighbour graph as lines between cells. It is available when the dataset has one; for an AnnData file, choose the graph under Session › Data mapping.',
      'Only edges between visible cells are drawn, so filters thin the graph too. Max edges caps how many are drawn; on large datasets keep it low to stay fast.',
    ],
    links: [
      doc('Connectivity edges', 'c_core_interactions/07_screenshots', 'connectivity-edges'),
      doc('Name a graph when serving', 'b_data_loading/04_server_tutorial', 'launch-choices-what-the-viewer-opens-on'),
      doc('Choose a graph', 'b_data_loading/13_data_mapping', 'neighbour-graph'),
    ],
  },
  'vector-field': {
    title: 'Vector field',
    body: [
      'Animates particles along per-cell vectors, such as RNA velocity or drift, each bound to one embedding.',
      'It appears when the view shows an embedding the dataset has a vector field for. Particle density and trail length cost the most. With Sync with LOD on, a reduced level of detail also draws fewer particles, spawned only from the cells that level shows.',
    ],
    links: [
      doc('Enable the overlay', 'i_vector_field_velocity/02_enabling_overlay_and_selecting_field', 'availability-states'),
      doc('Overlay settings', 'i_vector_field_velocity/03_core_parameters_document_exact_ui_labels', 'exact-labels-ranges-and-initial-values'),
    ],
  },

  // ------------------------------------------------------------- Navigation
  'navigation-mode': {
    title: 'Navigation mode',
    body: [
      {
        list: [
          'Orbit: rotate around an anchor. Best for 3D.',
          'Planar: pan and zoom a flat map. Best for 1D and 2D.',
          'Free-fly: a first-person camera, moved with W A S D.',
        ],
      },
      'Every view navigates on its own: a view showing a 3D embedding orbits and a 1D or 2D one pans, unless you choose another mode for it, which it keeps for that dimension. This setting edits the focused view -- and the views linked to its camera, which show the same embedding; Applies to names them. Shortcuts: O, P and G. Camera path keyframes record the mode they were saved in.',
    ],
    links: [
      doc('Navigation modes', 'c_core_interactions/01_navigation_modes_orbit_planar_free_fly', 'pick-the-right-mode-fast-guidance'),
      doc('Each view navigates on its own', 'c_core_interactions/01_navigation_modes_orbit_planar_free_fly', 'each-view-navigates-on-its-own'),
    ],
  },

  'pointer-lock': {
    title: 'Capture pointer',
    body: [
      'Hides the cursor so moving the mouse turns the camera without dragging. Press Esc to release it.',
      'Some embedded pages, such as notebooks, do not allow pointer capture.',
    ],
    links: [
      doc('Free-fly controls', 'c_core_interactions/02_camera_controls_advanced', 'free-fly-controls'),
    ],
  },

  // ---------------------------------------------------------- Compare views

  'view-representation': {
    title: 'What a view shows',
    body: [
      'The embedding the selected view shows: any one turned on under Session › Data mapping, of any dimension. Two views can show two 3D embeddings, or a 3D and a 2D one.',
      'Keys 1, 2 and 3 show that dimension’s default in the selected view; pressed again, they step through its other embeddings.',
      'Every view shows the same cells, so a highlight or selection in one appears in all. Colouring, filters, camera, navigation mode, centroid labels and vector fields stay with each view. Sessions keep each view’s embedding.',
    ],
    links: [
      doc('Several embeddings at once', 'b_data_loading/13_data_mapping', 'several-embeddings-at-once'),
      doc('Keys 1, 2 and 3', 'c_core_interactions/05_dimension_switching_1d_2d_3d', 'keys-1-2-and-3'),
    ],
  },

  'multiview': {
    title: 'Views',
    body: [
      'Keep view adds a view: a copy of the selected one, as many as you like. Each row says what its view shows and the field it is coloured by; select a row, then change what it shows, its colouring or its filters -- they stay with that view only.',
      'Grid compare shows all views side by side; Edit selected view shows the selected one large.',
      'Every view is drawn each frame, so on large datasets turn on Level of detail before keeping several. Views of one embedding share its GPU buffers.',
    ],
    links: [
      doc('Multiview', 'c_core_interactions/04_view_layout_live_snapshots_small_multiples', 'exact-controls'),
      doc('Select a view to edit', 'c_core_interactions/04_view_layout_live_snapshots_small_multiples', 'select-and-edit-the-intended-panel'),
    ],
  },
  'camera-link': {
    title: 'Link cameras',
    body: [
      'Views that show the same embedding share one camera and navigation mode: turn one and they all turn. Rows marked linked show which.',
      'Views of different embeddings always keep their own cameras -- one camera cannot frame a 3D and a 2D layout, or two embeddings with different shapes -- so the button is available only when two open views show the same embedding.',
    ],
    links: [
      doc('Linked cameras', 'c_core_interactions/04_view_layout_live_snapshots_small_multiples', 'linked-cameras'),
    ],
  },


  // ---------------------------------------------------- Coloring & filtering
  'color-by': {
    title: 'Color by',
    body: [
      'One field colours the selected view at a time. Categorical obs are labels such as cell types; continuous obs are numbers such as scores; gene expression reads one gene from the expression matrix.',
      'Choosing a field in one list clears the others. The buttons beside each list duplicate, rename, delete or clear the field; deleted fields can be restored below.',
    ],
    links: [
      doc('Field selector', 'd_fields_coloring_legends/02_field_selector_ux', 'the-one-active-field-rule-obs-vs-gene-expression'),
      doc('Field types', 'd_fields_coloring_legends/01_field_types_and_sources', 'categorical-vs-continuous-what-changes-in-the-app'),
    ],
  },
  'legend': {
    title: 'Legend',
    body: [
      'For a categorical field: tick a category to show or hide its cells, click a swatch to change its colour, and rename, merge or delete categories. Centroids mark the centre of each category on the plot.',
      'For a continuous field: pick a colour map and drag the range to rescale colours or filter cells.',
      'Hiding a category or narrowing a range is a filter on the selected view.',
    ],
    links: [
      doc('Legend', 'd_fields_coloring_legends/04_legend_behavior', 'categorical-legend-checkboxes-swatches-category-tools'),
      doc('Color-by behavior', 'd_fields_coloring_legends/03_color_by_behavior', 'categorical-color-by-discrete-labels'),
    ],
  },
  'deleted-fields': {
    title: 'Deleted fields',
    body: [
      'A deleted field, or the column a rename, merge or category deletion replaced, waits here until you decide. Restore brings it back exactly as it was.',
      'Confirm deletion removes it for good and frees its memory; it cannot be restored afterwards. Fields waiting here are saved with the session.',
    ],
    links: [
      doc('Deleted fields', 'd_fields_coloring_legends/02_field_selector_ux', 'deleted-fields-panel-restore-vs-confirm-deletion'),
    ],
  },
  'create-categorical': {
    title: 'Create categorical',
    body: [
      'Turns highlight pages into a new categorical obs column: drag pages into the drop zone, or pick one under Add page, and each page becomes one category label.',
      'If pages overlap, choose which label the shared cells get: the first page, the last page, one label for every overlap, or one label for each intersection. Cells in no page get the uncovered label. Name the column and press Create; it is colored, filtered and saved with the session like any other field.',
    ],
    links: [
      doc('Create categorical', 'f_highlighting_selection/03_highlight_ui', 'create-categorical-turn-pages-into-a-real-obs-column'),
    ],
  },
  'compare-pages': {
    title: 'Choosing pages',
    body: [
      'Click a page to include or exclude it; the analysis compares the pages you select. Click a page’s color square to recolor it in the plots.',
      '“Rest of” a page means every cell not in it. In Quick mode, Dynamic follows whichever highlight page is active instead of a fixed choice.',
    ],
    links: [
      doc('Page selection', 'h_analysis/02_analysis_ui_overview', 'page-selection-ui-compare-pages'),
    ],
  },
  'analysis-quick': {
    title: 'Quick',
    body: [
      'Automatic insights for the selected pages, with no settings to choose: the composition of every categorical obs field and summary statistics of every continuous one.',
      'By default it follows the active highlight page; pick pages to combine several. Results update as the pages change.',
    ],
    links: [
      doc('Quick mode', 'h_analysis/03_analysis_mode_quick_insights', 'what-quick-mode-is-for-and-what-it-is-not'),
    ],
  },
  'analysis-detailed': {
    title: 'Detailed',
    body: [
      'One variable (an obs field or a gene) compared across the pages you choose, with the plot type of your choice, a summary table and a statistical test between pages.',
      'Use the expand button for a larger view with plot options and CSV/figure export.',
    ],
    links: [
      doc('Detailed mode', 'h_analysis/04_analysis_mode_detailed_analysis', 'what-detailed-mode-is-for'),
      doc('Choosing a plot type', 'h_analysis/04_analysis_mode_detailed_analysis', 'choosing-the-right-plot-type'),
    ],
  },
  'analysis-correlation': {
    title: 'Correlation',
    body: [
      'How two variables move together within each selected page: a scatter plot of X against Y, and the correlation coefficient r with its p-value per page.',
      'Only cells with a value for both variables count. Color the points by a categorical field to look for groups that drive the relationship.',
    ],
    links: [
      doc('Correlation mode', 'h_analysis/05_analysis_mode_correlation_analysis', 'what-correlation-mode-is-for'),
    ],
  },
  'correlation-method': {
    title: 'Correlation method',
    body: [
      'Pearson measures a straight-line relationship on the values themselves. Spearman ranks the values first, so it captures any steadily rising or falling relationship and resists outliers.',
      'As a rough guide to the strength of r: 0.8 or more is very strong, 0.6 strong, 0.4 moderate and 0.2 weak.',
    ],
    links: [
      doc('Pearson vs Spearman', 'h_analysis/05_analysis_mode_correlation_analysis', 'pearson-vs-spearman'),
    ],
  },
  'analysis-differential': {
    title: 'Differential expression',
    body: [
      'Finds genes that differ between two groups of cells: two pages, or a page and the rest of it. Every gene is tested, in batches, and ranked by significance.',
      'Each gene gets a log2 fold change and a p-value corrected for multiple testing (FDR). Press Run; the result opens as a volcano plot with adjustable thresholds.',
    ],
    links: [
      doc('Differential expression', 'h_analysis/06_analysis_mode_differential_expression_de', 'what-de-is-for-in-cellucid'),
      doc('Statistics', 'h_analysis/06_analysis_mode_differential_expression_de', 'statistics-exact-implementation'),
    ],
  },
  'analysis-test-method': {
    title: 'Statistical method',
    body: [
      'Wilcoxon (Mann–Whitney U) compares ranks, so it makes no assumption about the shape of the expression distribution and is robust to outliers. It is the usual choice for single-cell data.',
      'The t-test (Welch’s) compares means and assumes roughly normal values; it is faster and fine for large groups of well-behaved data.',
    ],
    links: [
      doc('DE statistics', 'h_analysis/06_analysis_mode_differential_expression_de', 'statistics-exact-implementation'),
      doc('Marker statistics', 'h_analysis/08_analysis_mode_genes_panel', 'statistics-what-is-computed'),
    ],
  },
  'analysis-performance': {
    title: 'Performance settings',
    body: [
      {
        list: [
          'Batch size: how many genes are loaded and tested at a time; the recommended size is computed from the cell and gene counts.',
          'Memory budget: the most working memory the analysis may hold.',
          'Network parallelism: how many genes are requested at once from the data source.',
          'Compute parallelism: how many test batches run at once; Auto uses every worker the browser started.',
        ],
      },
      'Lower values use less memory and network; higher values finish sooner on a strong machine.',
    ],
    links: [
      doc('When DE is slow', 'h_analysis/06_analysis_mode_differential_expression_de', 'performance-settings-when-de-is-slow'),
    ],
  },
  'analysis-signature': {
    title: 'Gene signature',
    body: [
      'Scores every cell by a set of genes, such as a pathway or a cell-type marker list, and compares the scores across the pages you choose.',
      'Genes the dataset does not have are skipped. The score updates as you edit the list.',
    ],
    links: [
      doc('Gene signature', 'h_analysis/07_analysis_mode_gene_signature', 'what-a-gene-signature-is-user-facing'),
    ],
  },
  'gene-signature-genes': {
    title: 'Signature genes',
    body: [
      'Type gene symbols separated by commas, such as CD3E, CD4, CD8A. Symbols are matched to the dataset’s gene names; a symbol it does not contain is left out of the score.',
    ],
    links: [
      doc('Signature input', 'h_analysis/07_analysis_mode_gene_signature', 'inputs-genes-pages'),
    ],
  },
  'gene-signature-scoring': {
    title: 'Scoring',
    body: [
      'The score of a cell is the mean, sum or median of its expression over the signature genes. Mean is the usual choice; sum grows with the number of genes, and median ignores a single extreme gene.',
      'Normalization then rescales the scores: Z-score in standard deviations from the mean, Min-Max to the range 0 to 1, or None.',
    ],
    links: [
      doc('Scoring algorithm', 'h_analysis/07_analysis_mode_gene_signature', 'scoring-algorithm-exact'),
      doc('Normalization', 'h_analysis/07_analysis_mode_gene_signature', 'normalization-options-what-they-do'),
    ],
  },
  'analysis-marker-genes': {
    title: 'Marker genes',
    body: [
      'Finds the genes that mark each category of a categorical field, testing each group against all other cells, and shows them as a ranked list or a heatmap.',
      'Results are cached per field and settings, so reopening is instant; untick Use cached results to recompute.',
    ],
    links: [
      doc('Marker genes', 'h_analysis/08_analysis_mode_genes_panel', 'what-marker-genes-is-for'),
    ],
  },
  'marker-genes-mode': {
    title: 'Mode',
    body: [
      {
        list: [
          'Ranked genes: the top markers of each group, sorted by significance.',
          'Clustered: a heatmap of the markers with genes and groups ordered by hierarchical clustering.',
          'Custom genes: a heatmap of the genes you list.',
        ],
      },
    ],
    links: [
      doc('Ranked genes', 'h_analysis/08_analysis_mode_genes_panel', 'ranked-genes-mode'),
      doc('Clustered', 'h_analysis/08_analysis_mode_genes_panel', 'clustered-mode'),
    ],
  },
  'marker-genes-clustering': {
    title: 'Clustering',
    body: [
      'How the heatmap orders genes (rows) and groups (columns). Distance: Correlation (1 − Pearson r, the default) groups genes with similar patterns, Euclidean compares raw values, Cosine compares direction only.',
      'Linkage: Average gives balanced clusters, Complete compact ones, Single chained ones. Untick a clustering box to keep that axis in its original order.',
    ],
    links: [
      doc('Clustered mode', 'h_analysis/08_analysis_mode_genes_panel', 'clustered-mode'),
    ],
  },
  'export-framing': {
    title: 'Framing',
    body: [
      'Plot size sets the figure’s size; a preset or your own width and height. Show preview draws the figure as it will be exported, which framing needs.',
      'Frame export crops the figure: drag the frame in the preview, or use the buttons to fit it. Lock keeps its aspect ratio. The line under the buttons gives the plot and frame sizes.',
    ],
    links: [
      doc('Preview vs export', 'k_figure_export/02_export_ui_walkthrough', 'preview-vs-export'),
      doc('Frame export', 'k_figure_export/02_export_ui_walkthrough', 'framing-overlay-crop-mental-model'),
    ],
  },
  'export-labels': {
    title: 'Labels and annotations',
    body: [
      'Title, axes, legend, reference grid, 3D orientation and depth sort are drawn into the figure when ticked. Clear the X or Y label to hide it; the legend can sit right or below.',
      'Never exported: the orbit compass, lasso and selection radius indicators, multiview panel title chips and the projectile sandbox. They help you work, but are not part of the data.',
    ],
    links: [
      doc('Titles, legends, axes', 'k_figure_export/02_export_ui_walkthrough', 'titles-captions-legends-axes'),
    ],
  },
  'export-style': {
    title: 'Style',
    body: [
      'Background: match the viewer, white, transparent, or a custom color. Font and text sizes apply to every label; Auto text scales them with the figure size, or set each size yourself.',
    ],
    links: [
      doc('Style controls', 'k_figure_export/02_export_ui_walkthrough', 'style-controls-that-affect-export-readability'),
    ],
  },
  'export-download': {
    title: 'Download',
    body: [
      'PNG is a high-DPI image; SVG keeps text and shapes editable. For SVG, Full vector writes every point, Optimized vector writes the exact number you keep, and Hybrid embeds the shader-rendered points as an image inside the vector figure.',
      'Vector points carry the viewer’s fog but are flat discs: only Hybrid and PNG reproduce the 3D sphere lighting. Export all views writes each multiview panel.',
    ],
    links: [
      doc('Download options', 'k_figure_export/02_export_ui_walkthrough', 'download-options-and-large-dataset-strategies'),
      doc('Choose a format', 'k_figure_export/03_export_formats_and_renderers', 'decision-table-choose-the-right-mode'),
    ],
  },
  'community-bundle': {
    title: 'Merged bundles',
    body: [
      'An author merged duplicate suggestions into one bundle. Its vote total counts each person once, however many of the merged cards they voted on.',
      'If you did not vote on the bundle’s main card, your bundle vote comes from your votes on its members (the majority; a tie counts as none) and shows with a dashed badge. Each card keeps its own comments; merge rows show the chain and any notes.',
    ],
    links: [
      doc('Merge duplicates', 'j_community_annotation/02_author_guide', 'merge-duplicate-suggestions-moderation'),
    ],
  },
  'community-annotated-columns': {
    title: 'Annotated columns',
    body: [
      'Which categorical columns are open for voting. Pick a column and add it to, or remove it from, the annotation list; voting then happens per category of that column.',
      'With a repository connected, only its authors (maintain or admin) can change the list, and publishing writes it for everyone.',
    ],
    links: [
      doc('Annotated columns', 'j_community_annotation/03_ui_reference', 'annotated-columns-author-only'),
    ],
  },
  'cell-info': {
    title: 'Cell info',
    body: [
      'Shows a card for the cell under the pointer: its value of the field the view is coloured by and, for a continuous field, where that value sits on the colour scale. For a categorical field it counts the cells of that category visible in the view, which are exactly the cells selecting the category would pick. It works in every view of a grid.',
      'On a touch screen, press and hold a cell. The card stays until the next touch.',
      'It is on by default. It never loads a field and never redraws the plot, and it waits while the camera moves. On datasets above two million cells the first hover builds a spatial index, which takes a moment once.',
    ],
    links: [
      doc('Cell info', 'd_fields_coloring_legends/08_cell_info', 'what-the-card-shows'),
      doc('Performance', 'd_fields_coloring_legends/08_cell_info', 'cost-on-large-datasets'),
    ],
  },
  'cell-info-categories': {
    title: 'Show recent fields',
    body: [
      'Adds the cell’s label in up to four other categorical fields you have recently coloured by, so you can read, for example, its cluster, batch and sample while the view is coloured by cell type.',
      'Recent means already in memory: a field is listed once you have coloured by it in this session. Hovering never loads a field, which keeps the card free on large datasets.',
    ],
    links: [
      doc('Cell info', 'd_fields_coloring_legends/08_cell_info', 'what-the-card-shows'),
    ],
  },
  'log-color-scale': {
    title: 'Log color scale',
    body: [
      'Colors follow the logarithm of each value, which spreads out a field whose values span several orders of magnitude, such as counts. Only the coloring changes: filters and the visible range still use the raw values.',
      'Zero, negative and missing values have no logarithm and take the None color.',
    ],
    links: [
      doc('Log scale', 'd_fields_coloring_legends/03_color_by_behavior', 'log-scale-coloring-only'),
      doc('Log scale toggle', 'd_fields_coloring_legends/04_legend_behavior', 'log-scale-toggle'),
    ],
  },
  'color-rescale': {
    title: 'Rescale colors',
    body: [
      'On: the color map stretches across the visible range set below, so the cells you keep use every color and small differences stand out.',
      'Off: colors span the field’s full data range, so one color always means the same value, whatever the range.',
    ],
    links: [
      doc('Rescale to range', 'd_fields_coloring_legends/03_color_by_behavior', 'rescale-to-range-contrast-control'),
    ],
  },
  'live-filtering': {
    title: 'Live filtering',
    body: [
      'On: cells outside the visible range are hidden as you drag the sliders.',
      'Off: drag freely, then press Filter to apply the range once. This is smoother on large datasets, where every drag step refilters millions of cells.',
    ],
    links: [
      doc('Live filtering vs Filter', 'd_fields_coloring_legends/03_color_by_behavior', 'live-filtering-vs-filter-performance-predictability'),
    ],
  },
  'filters': {
    title: 'Filters',
    body: [
      'Every filter hiding cells in the selected view, from the legend, the range sliders and the outlier filter. Untick one to pause it; remove it to drop it.',
      'Filters belong to the view they were set in: other views and kept views are not changed. Hidden cells are not drawn and cannot be selected.',
    ],
    links: [
      doc('Active filters', 'e_filtering/03_filter_stack_ui_active_filters', 'practical-path-what-each-control-means-exact-semantics'),
      doc('Filtering', 'e_filtering/01_filtering_mental_model', 'mental-model-one-sentence'),
    ],
  },
  'outlier-filter': {
    title: 'Outlier filter',
    body: [
      'Hides cells far from the centre of their category in a latent space (an `obsm` array such as scVI or PCA), not in the 2D/3D layout. The value is a share of each category: at 95% the farthest 5% of every category are hidden; at 100% nothing is.',
      'Choose the latent space in Data mapping (“Outliers in”). A file written by `prepare()` or `cellucid_prepare()` with a latent space stores every categorical field’s distances, so the filter works at once; for any other file the first use reads the latent space once to compute them, with progress and Cancel.',
      'Only categories of at least 10 cells are measured (a file or launch can set another number, `centroid_min_points`). The filter applies to the active field in the selected view.',
    ],
    links: [
      doc('Outlier filtering', 'e_filtering/02_outlier_filtering_per_active_field', 'what-this-filter-is-and-is-not'),
      doc('Stored or computed', 'e_filtering/02_outlier_filtering_per_active_field', 'stored-or-computed'),
    ],
  },

  // ------------------------------------------------------------ Highlighting
  'selection': {
    title: 'Selection',
    body: [
      'Hold Alt and click or drag on the plot to select with the chosen tool. Add Shift to add to the selection, or Ctrl to subtract from it; Alt alone intersects with the selection in progress.',
      'Select mode does the same without Alt, for touch screens: a tap or drag with one finger selects, two fingers still zoom and pan, and Combine chooses how a new selection joins the last.',
      {
        list: [
          'Annotation: the clicked cell’s category, or a value range, on the field of the view you click in.',
          'KNN drag: neighbours of the clicked cell through the graph; drag further for more steps. Graph status appears in notifications.',
          'Proximity drag: cells within a radius of the clicked cell in 3D; drag to widen it.',
          'Lasso: cells inside a drawn outline. Rotate and draw again to intersect, carving out a 3D region.',
        ],
      },
    ],
    links: [
      doc('Selection tools', 'f_highlighting_selection/02_selection_tools_document_each_tool', 'tool-overview-choose-quickly'),
      doc('Universal rules', 'f_highlighting_selection/02_selection_tools_document_each_tool', 'universal-rules-apply-to-all-tools'),
    ],
  },
  'highlights': {
    title: 'Highlights',
    body: [
      'Each selection becomes a highlighted group on the current page. Pages are alternative sets of groups: switch tabs to compare them, or add a page with +.',
      'Groups drive Analysis (each page is a group of cells to compare) and can be turned into a new categorical obs column with Create categorical.',
    ],
    links: [
      doc('Pages and groups', 'f_highlighting_selection/03_highlight_ui', 'highlight-pages-tabs-alternative-workspaces'),
      doc('Create categorical', 'f_highlighting_selection/03_highlight_ui', 'create-categorical-turn-pages-into-a-real-obs-column'),
    ],
  },

  // ------------------------------------------------------------ Camera path
  'keyframes': {
    title: 'Keyframes',
    body: [
      'Save position records the camera of the focused view as a keyframe. With two or more, a playback bar appears over the plot.',
      'Each keyframe’s time to the next can be set, or left to auto, where Default speed decides it. Keyframes are saved in sessions.',
    ],
    links: [
      doc('Camera path playback', 'c_core_interactions/02_camera_controls_advanced', 'camera-path-playback-is-opt-in'),
    ],
  },
  'playback': {
    title: 'Playback',
    body: [
      'How the camera travels between keyframes: Catmull-Rom gives a smooth curve through every keyframe, Linear straight segments; SLERP turns smoothly; easing slows the start or end of each move.',
      'Loop repeats the path. Autoplay starts a ready path at once; it is off by default, and a restored session plays only if it was saved with Autoplay on.',
    ],
    links: [
      doc('Camera path playback', 'c_core_interactions/02_camera_controls_advanced', 'camera-path-playback-is-opt-in'),
    ],
  },
  'default-speed': {
    title: 'Default speed',
    body: [
      'How fast the camera travels between keyframes whose timing is auto. Keyframes with a set duration keep it.',
    ],
    links: [
      doc('Camera path playback', 'c_core_interactions/02_camera_controls_advanced', 'camera-path-playback-is-opt-in'),
    ],
  },

  // ---------------------------------------------------------- Figure export
  'figure-export': {
    title: 'Figure export',
    body: [
      'Saves the view as it is drawn: the same cells, colours, filters and camera, with an optional title, axes, legend and highlighted selection.',
      'SVG keeps text and the legend editable for a paper figure; with hundreds of thousands of points, its hybrid strategy rasterises the points so the file stays manageable. PNG is a raster at the DPI you choose and opens anywhere.',
      'Layers it cannot draw block the export with a message: connectivity edges, the vector field and volumetric smoke. Turn them off, or switch the render mode to points, first.',
    ],
    links: [
      doc('Export walkthrough', 'k_figure_export/02_export_ui_walkthrough', 'fast-path-export-a-decent-figure-in-2-minutes'),
      doc('SVG or PNG', 'k_figure_export/03_export_formats_and_renderers', 'decision-table-choose-the-right-mode'),
    ],
  },

  // -------------------------------------------------------------- Shortcuts
  'shortcuts-general': {
    title: 'General shortcuts',
    body: [
      'Shortcuts act on the focused view, and never while you are typing in a field. Press ? to open this panel from anywhere.',
    ],
    links: [
      doc('Camera shortcuts', 'c_core_interactions/02_camera_controls_advanced', 'keyboard-shortcuts-that-affect-camera-navigation'),
    ],
  },
  'shortcuts-navigation': {
    title: 'Navigation keys',
    body: [
      'W A S D orbit, pan or move depending on the navigation mode; hold Shift to go faster. Their speed is the Keyboard speed setting in Navigation.',
    ],
    links: [
      doc('Camera shortcuts', 'c_core_interactions/02_camera_controls_advanced', 'keyboard-shortcuts-that-affect-camera-navigation'),
    ],
  },
  'shortcuts-zoom': {
    title: 'Zoom keys',
    body: [
      'Zoom in and out in Orbit and Planar mode; each has two keys, so one is in reach on any keyboard layout. Free-fly has no zoom: W and S move forward and back instead.',
    ],
    links: [
      doc('Camera shortcuts', 'c_core_interactions/02_camera_controls_advanced', 'keyboard-shortcuts-that-affect-camera-navigation'),
    ],
  },
  'shortcuts-free-fly': {
    title: 'Free-fly keys',
    body: [
      'E and Q move the camera straight up and down, whichever way it faces. Esc releases a captured pointer, so the mouse moves the cursor again.',
    ],
    links: [
      doc('Free-fly controls', 'c_core_interactions/02_camera_controls_advanced', 'free-fly-controls'),
    ],
  },
  'shortcuts-selection': {
    title: 'Selection keys',
    body: [
      'Alt runs the active selection tool. Esc first cancels a selection in progress, then leaves Select mode. X clears the highlights on the current page.',
    ],
    links: [
      doc('Selection tools', 'f_highlighting_selection/02_selection_tools_document_each_tool', 'universal-rules-apply-to-all-tools'),
    ],
  },

  // ------------------------------------------------------------- Benchmark
  'synthetic-data': {
    title: 'Synthetic data',
    body: [
      'Replaces the open dataset with generated points, to find how many cells this device draws smoothly. Reload the page to get the dataset back.',
      'The pattern changes how hard the data is: Uniform random is the worst case for level of detail and culling, Atlas-like resembles a real atlas. Change rendering settings in Visualization while it runs.',
    ],
    links: [
      doc('Benchmark tools', 'n_benchmarking_performance/05_benchmark_tools', 'quick-start-3-minutes'),
      doc('Data patterns', 'n_benchmarking_performance/05_benchmark_tools', 'data-patterns-how-to-choose'),
    ],
  },
  'diagnostics': {
    title: 'Diagnostics',
    body: [
      'Analyze performance runs a short measurement of the current view, names what limits the frame rate (fill rate, vertex count, CPU, level-of-detail selection and others), and lists what to change.',
      'Copy situation report copies the browser, GPU, dataset size and renderer state as text, for a bug report. Read it for anything private before you share it.',
    ],
    links: [
      doc('Analyze performance', 'n_benchmarking_performance/05_benchmark_tools', 'analyze-performance-why-is-it-slow'),
      doc('Situation report', 'n_benchmarking_performance/05_benchmark_tools', 'copy-situation-report-use-this-for-bug-reports'),
    ],
  },

  // -------------------------------------------------- Community annotation
  'community-intro': {
    title: 'Community annotation',
    body: [
      'Lets a group vote on labels for the categories of a column, with the votes kept in a GitHub repository.',
      'Connect an annotation repository to start. Voting controls appear only while a repository is connected.',
    ],
    links: [
      doc('Community annotation', 'j_community_annotation/index', 'quickstart-choose-your-path'),
      doc('Connect a repository', 'j_community_annotation/01_annotator_guide', 'connect-to-the-annotation-repo-first-time'),
    ],
  },
  'community-sync': {
    title: 'GitHub sync',
    body: [
      'Votes and suggestions are saved in this browser first; publishing them to GitHub is optional. Pull before you work to see everyone else’s votes.',
      'Repository authors choose which columns can be annotated. Your sign-in token is kept only for this tab, and the GitHub App reaches only the repositories you enable.',
    ],
    links: [
      doc('Pull latest', 'j_community_annotation/01_annotator_guide', 'pull-latest-what-it-does-and-why-it-matters'),
      doc('Publish your work', 'j_community_annotation/01_annotator_guide', 'publish-your-work-direct-push-vs-pull-request'),
    ],
  },
  'community-consensus-column': {
    title: 'Consensus column',
    body: [
      'Builds a local obs column from the current votes: each category becomes its consensus label, Disputed, or Pending.',
      'It does not change the voting rules and publishes nothing; it is only for colouring and analysis here.',
    ],
    links: [
      doc('Consensus column', 'j_community_annotation/02_author_guide', 'build-a-consensus-column-optional-local'),
    ],
  },
  'community-consensus-settings': {
    title: 'Consensus settings',
    body: [
      'How votes on this column become a consensus label: the threshold a suggestion’s net support must reach, and how many annotators must vote first.',
      'Changes stay in this browser until you click Apply; publishing as an author writes them to `annotations/config.json` for everyone.',
    ],
    links: [
      doc('Tune consensus rules', 'j_community_annotation/02_author_guide', 'tune-consensus-rules-per-column'),
      doc('How consensus is computed', 'j_community_annotation/index', 'how-consensus-is-computed'),
    ],
  },
  'community-profile': {
    title: 'Profile',
    body: [
      'An optional name, title, ORCID and LinkedIn shown with your votes. Your GitHub username comes from sign-in.',
      'The profile is saved in this browser until you publish, which writes it to your user file in the repository; Pull reloads it.',
    ],
    links: [
      doc('Profile and identity', 'j_community_annotation/03_ui_reference', 'profile-optional-and-your-identity-modal'),
    ],
  },
  'community-snapshot': {
    title: 'Consensus snapshot',
    body: [
      'Downloads `cellucid-consensus.json`: the current consensus for every annotated column, for use in other tools.',
      'It is built in this browser from the files last pulled, and never written back to GitHub. Pull first for the latest votes.',
    ],
    links: [
      doc('Export a consensus snapshot', 'j_community_annotation/02_author_guide', 'export-a-consensus-snapshot-for-downstream-tools'),
    ],
  },
  'community-cache': {
    title: 'Local cache',
    body: [
      {
        list: [
          'Clear session forgets your unpublished votes, suggestions and comments for this dataset and repository.',
          'Clear downloads removes the copies of repository files kept to make Pull faster.',
        ],
      },
      'Neither writes anything to GitHub.',
    ],
    links: [
      doc('Snapshot and cache', 'j_community_annotation/03_ui_reference', 'consensus-snapshot-local-cache'),
      doc('Where data lives', 'j_community_annotation/index', 'where-data-lives-local-vs-github'),
    ],
  },

  // ------------------------------------------------------- Cite and Share
  'cite': {
    title: 'Citing Cellucid',
    body: [
      'Cite this reference when you use the web app, the Python package or the R package. It is read from the CITATION.cff the site is published with.',
      'While it has no DOI it is a placeholder: the bioRxiv preprint is in preparation, and this reference changes when the preprint is published.',
      'For a built-in sample dataset, also cite the study it came from; each sample records its citation.',
    ],
    links: [
      doc('Citing a sample', 'b_data_loading/12_sample_dataset_provenance', 'what-to-do-with-this'),
    ],
  },
  'share-link': {
    title: 'Share link',
    body: [
      'A link to www.cellucid.com that reopens this dataset for anyone, carrying only what picks the dataset.',
      'It reopens the dataset, not your view of it: to share the camera, colours, filters and highlights, save a session file and send it with the link.',
      'Only a sample, a public GitHub export or a server other people can reach has a link; a file from disk, a notebook or a server on localhost does not.',
    ],
    links: [
      doc('Which datasets can be shared', 'l_sessions_sharing/13_share_links_badges_and_embeds', 'which-datasets-can-be-shared'),
    ],
  },
  'share-badge': {
    title: 'Open in Cellucid badge',
    body: [
      'Markdown for a README, a wiki page or an issue. It renders as a small badge that opens this dataset in one click.',
      'Put it in the repository that hosts your data.',
    ],
    links: [
      doc('Badge', 'l_sessions_sharing/13_share_links_badges_and_embeds', 'open-in-cellucid-badge'),
      doc('Dataset repositories', 'b_data_loading/11_custom_dataset_repository', 'the-repository-contract'),
    ],
  },
  'share-embed': {
    title: 'Embed',
    body: [
      'HTML for a lab website, a project page or a supplementary site: the viewer opens inside a frame on that page.',
      { list: [
        'Full width and 640 px tall suits most pages; below 720 px wide the viewer uses its phone layout.',
        'Visitors need a browser with WebGL2.',
        'The frame loads only when it scrolls into view.',
      ] },
    ],
    links: [
      doc('Embedding', 'l_sessions_sharing/13_share_links_badges_and_embeds', 'embed-in-a-web-page'),
    ],
  },
};

const REQUIRED_KEYS = Object.freeze(['title', 'body', 'links']);

function freezeTip(key, tip) {
  for (const field of REQUIRED_KEYS) {
    if (!(field in tip)) throw new TypeError(`Info tip "${key}" has no ${field}`);
  }
  if (typeof tip.title !== 'string' || !tip.title.trim()) {
    throw new TypeError(`Info tip "${key}" needs a title`);
  }
  if (!Array.isArray(tip.body) || tip.body.length === 0) {
    throw new TypeError(`Info tip "${key}" needs a body`);
  }
  if (!Array.isArray(tip.links) || tip.links.length === 0) {
    throw new TypeError(`Info tip "${key}" needs at least one docs link`);
  }
  return Object.freeze({
    title: tip.title,
    body: Object.freeze(tip.body.map(block => (
      typeof block === 'string' ? block : Object.freeze({ list: Object.freeze([...block.list]) })
    ))),
    links: Object.freeze([...tip.links]),
  });
}

/** Every tip, keyed by the name markup and components refer to it by. */
export const INFO_TIPS = Object.freeze(Object.fromEntries(
  Object.entries(TIPS).map(([key, tip]) => [key, freezeTip(key, tip)]),
));

/** The absolute URL of one docs link. */
export function docsUrl(link) {
  const page = `${DOCS_BASE_URL}${link.page}.html`;
  return link.anchor === null ? page : `${page}#${link.anchor}`;
}

export function requireInfoTip(key) {
  if (typeof key !== 'string' || !Object.hasOwn(INFO_TIPS, key)) {
    throw new TypeError(`Unknown info tip "${String(key)}"`);
  }
  return INFO_TIPS[key];
}

/** Append `text` to `parent`, setting `backticked` spans as code. */
function appendRichText(documentRef, parent, text) {
  const parts = text.split('`');
  if (parts.length % 2 === 0) {
    throw new TypeError(`Unbalanced code span in info tip text: ${text}`);
  }
  parts.forEach((part, index) => {
    if (part === '') return;
    if (index % 2 === 1) {
      const code = documentRef.createElement('code');
      code.textContent = part;
      parent.appendChild(code);
    } else {
      parent.appendChild(documentRef.createTextNode(part));
    }
  });
}

/**
 * Fill an `.info-tooltip` element with the tip `key`: a title row with a close
 * button, the body, and the docs links. Any previous content is replaced.
 *
 * @param {HTMLElement} popover
 * @param {string} key
 */
export function renderInfoTip(popover, key) {
  const tip = requireInfoTip(key);
  const documentRef = popover.ownerDocument;
  const el = (tag, className) => {
    const node = documentRef.createElement(tag);
    if (className) node.className = className;
    return node;
  };

  const content = el('div', 'info-tooltip-content');
  const header = el('div', 'info-tip-header');
  const title = el('p', 'info-tip-title');
  title.textContent = tip.title;
  const close = el('button', 'info-tip-close');
  close.type = 'button';
  close.setAttribute('aria-label', `Close: ${tip.title}`);
  close.setAttribute('data-info-tip-close', '');
  close.textContent = '×';
  header.append(title, close);
  content.appendChild(header);

  for (const block of tip.body) {
    if (typeof block === 'string') {
      const paragraph = el('p', 'info-tip-text');
      appendRichText(documentRef, paragraph, block);
      content.appendChild(paragraph);
    } else {
      const list = el('ul', 'info-tip-list');
      for (const item of block.list) {
        const li = el('li');
        appendRichText(documentRef, li, item);
        list.appendChild(li);
      }
      content.appendChild(list);
    }
  }

  const links = el('p', 'info-tip-links');
  const lead = el('span', 'info-tip-links-lead');
  lead.textContent = 'Learn more:';
  links.appendChild(lead);
  tip.links.forEach((link, index) => {
    if (index > 0) {
      const separator = el('span', 'info-tip-links-separator');
      separator.setAttribute('aria-hidden', 'true');
      separator.textContent = '·';
      links.appendChild(separator);
    }
    const anchor = el('a', 'info-tip-link');
    anchor.href = docsUrl(link);
    anchor.target = '_blank';
    anchor.rel = 'noopener noreferrer';
    anchor.textContent = link.label;
    links.appendChild(anchor);
  });
  content.appendChild(links);

  popover.replaceChildren(content);
  popover.dataset.infoTip = key;
}

/** Render every static tip in `root` that names a key with `data-info-tip`. */
export function renderStaticInfoTips(root) {
  for (const popover of root.querySelectorAll('.info-tooltip[data-info-tip]')) {
    renderInfoTip(popover, popover.dataset.infoTip);
  }
}
